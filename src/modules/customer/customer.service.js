const ApiError = require('../../utils/ApiError');
const { toBool } = require('../../utils/permissions');
const { storeListPhotos } = require('../../utils/inlineImages');
const { nextCustomerCode } = require('../../utils/counter');
const customerRepo = require('./customer.repo');
const SalesOrder = require('../salesOrder/salesOrder.model');
const { STATE_CODES } = require('../../config/constants');

function productKey(item) {
  const code = String(item?.productCode || '')
    .trim()
    .toLowerCase();
  if (code) return `code:${code}`;
  const name = String(item?.product || '')
    .trim()
    .toLowerCase();
  return name ? `name:${name}` : '';
}

// Reads must not throw on an old product that today's validation rejects
// (renamed route, oversized image, ...): one bad row used to fail the whole list.
function readableSpec(product) {
  // Lazy require avoids circular import with salesOrder.service
  const { normalizeItem } = require('../salesOrder/salesOrder.service');
  try {
    return normalizeItem(product);
  } catch (error) {
    const plain = product?.toObject ? product.toObject() : { ...product };
    return { ...plain, images: Array.isArray(plain.images) ? plain.images : [], needsReview: error.message };
  }
}

function toPublicProduct(product) {
  const spec = readableSpec(product);
  return {
    id: product._id ? String(product._id) : undefined,
    product: spec.product,
    productCode: spec.productCode,
    productType: spec.productType,
    size: spec.size,
    material: spec.material,
    thickness: spec.thickness,
    width: spec.width,
    length: spec.length,
    color: spec.color,
    quantity: spec.quantity,
    unit: spec.unit,
    rate: spec.rate,
    discount: spec.discount,
    taxPercent: spec.taxPercent,
    hsnCode: spec.hsnCode || '',
    productionRoute: spec.productionRoute,
    otherProcess: spec.otherProcess || '',
    manufacturing: spec.manufacturing,
    roll: spec.roll,
    bag: spec.bag,
    printing: spec.printing,
    holes: spec.holes,
    tape: spec.tape,
    image: spec.image,
    images: spec.images || [],
    ...(spec.needsReview ? { needsReview: spec.needsReview } : {}),
  };
}

// A saved product that today's rules reject (an old route name, an oversized
// photo...) must not block the whole customer save: it is kept exactly as it
// was stored (and still shows "needs review"). New products must be valid.
function normalizeCustomerProducts(list, { stored = [] } = {}) {
  if (!Array.isArray(list)) return [];
  const { normalizeItem } = require('../salesOrder/salesOrder.service');
  const products = [];
  for (const raw of list) {
    const name = String(raw?.product || '').trim();
    if (!name) continue;
    let spec;
    try {
      spec = normalizeItem(raw);
    } catch (error) {
      const before = stored.find((p) => String(p._id) === String(raw?._id || raw?.id || ''));
      if (!before) throw error;
      console.error(`Customer product "${name}" kept unchanged: ${error.message}`);
      products.push(before.toObject ? before.toObject() : before);
      continue;
    }
    delete spec.currentStage;
    delete spec.stageWork;
    delete spec.amount;
    products.push(spec);
  }
  return products;
}

function toPublicCustomer(customer) {
  return {
    id: String(customer._id),
    code: customer.code,
    name: customer.name,
    companyName: customer.companyName || '',
    contactPerson: customer.contactPerson || '',
    mobile: customer.mobile || '',
    email: customer.email || '',
    gstNumber: customer.gstNumber || '',
    stateCode: customer.stateCode || '',
    billingAddress: customer.billingAddress || '',
    shippingAddress: customer.shippingAddress || '',
    priceCategory: customer.priceCategory || '',
    creditDays: customer.creditDays ?? null,
    creditLimit: customer.creditLimit || 0,
    products: (customer.products || []).map(toPublicProduct),
    isActive: customer.isActive,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };
}

function snapshotFromCustomer(customer) {
  return {
    code: customer.code,
    name: customer.name,
    companyName: customer.companyName || '',
    contactPerson: customer.contactPerson || '',
    mobile: customer.mobile || '',
    email: customer.email || '',
    gstNumber: customer.gstNumber || '',
    stateCode: customer.stateCode || '',
    billingAddress: customer.billingAddress || '',
    shippingAddress: customer.shippingAddress || '',
    priceCategory: customer.priceCategory || '',
  };
}

function trim(value) {
  return value == null ? '' : String(value).trim();
}

// Empty means "not set"; anything else must be a number of zero or more.
function optionalAmount(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new ApiError(400, `${label} must be zero or more`);
  return parsed;
}

// Optional two-digit GST state code (e.g. "27" for Maharashtra).
function stateCodeOf(value) {
  const code = trim(value);
  if (!code) return '';
  if (!/^\d{2}$/.test(code) || !STATE_CODES.has(code)) throw new ApiError(400, 'State must be a valid two-digit GST state code');
  return code;
}

function payloadFromBody(payload) {
  const creditDays = optionalAmount(payload.creditDays, 'Credit days');
  if (creditDays !== null && (creditDays > 365 || !Number.isInteger(creditDays))) throw new ApiError(400, 'Credit days must be a whole number up to 365');
  return {
    creditDays,
    creditLimit: optionalAmount(payload.creditLimit, 'Credit limit') ?? 0,
    name: trim(payload.name),
    companyName: trim(payload.companyName),
    contactPerson: trim(payload.contactPerson),
    mobile: trim(payload.mobile),
    email: trim(payload.email),
    gstNumber: trim(payload.gstNumber),
    stateCode: stateCodeOf(payload.stateCode),
    billingAddress: trim(payload.billingAddress),
    shippingAddress: trim(payload.shippingAddress),
    priceCategory: trim(payload.priceCategory),
  };
}

// The list leaves out saved products (each can carry several images), which
// made this response huge. Open one customer to get its products.
async function listCustomers() {
  // Products (and any photos in them) are never read for the list; the
  // database only counts them.
  const Customer = require('./customer.model');
  const customers = await Customer.aggregate([
    { $sort: { createdAt: -1 } },
    { $addFields: { productCount: { $size: { $ifNull: ['$products', []] } } } },
    { $project: { products: 0 } },
  ]);
  return customers.map((customer) => ({
    ...toPublicCustomer({ ...customer, products: [] }),
    productCount: customer.productCount,
  }));
}

async function getCustomer(id) {
  const customer = await customerRepo.findById(id);
  if (!customer) {
    throw new ApiError(404, 'Customer not found');
  }
  return toPublicCustomer(customer);
}

// `checkFields` (from the Customers screen) applies the owner's mandatory
// inputs; imports and draft orders create customers without them.
async function createCustomer(payload, { checkFields = false } = {}) {
  const data = payloadFromBody(payload);
  if (!data.name) {
    throw new ApiError(400, 'Customer name is required');
  }
  if (checkFields) await require('../formFields/formFields.service').assertComplete('customer', data, 'This customer');
  data.code = await nextCustomerCode();
  data.isActive = payload.isActive === undefined ? true : toBool(payload.isActive);
  await storeListPhotos(payload.products);
  data.products = normalizeCustomerProducts(payload.products);
  const customer = await customerRepo.create(data);
  return toPublicCustomer(customer);
}

async function updateCustomer(id, payload, { checkFields = false } = {}) {
  const customer = await customerRepo.findById(id);
  if (!customer) {
    throw new ApiError(404, 'Customer not found');
  }

  const data = payloadFromBody({ ...customer.toObject(), ...payload });
  if (!data.name) {
    throw new ApiError(400, 'Customer name is required');
  }
  // Switching a customer on or off is not an edit of their details: older
  // records missing a now-mandatory field can still be toggled.
  const onlyActive = Object.keys(payload || {}).every((key) => key === 'isActive');
  if (checkFields && !onlyActive) await require('../formFields/formFields.service').assertComplete('customer', data, 'This customer');
  if (payload.isActive !== undefined) data.isActive = toBool(payload.isActive);
  if (payload.products !== undefined && payload.products !== null) {
    if (!Array.isArray(payload.products)) {
      throw new ApiError(400, 'Products must be a list');
    }
    await storeListPhotos(payload.products);
    data.products = normalizeCustomerProducts(payload.products, { stored: customer.products || [] });
  }

  const updated = await customerRepo.updateById(id, data);
  return toPublicCustomer(updated);
}

// New products are added on every save; `refresh` (used on submit) also updates products already saved.
async function attachProductsFromOrder(customerId, items, { refresh = false } = {}) {
  if (!customerId || !Array.isArray(items) || !items.length) return;

  // Optimistic retry: two orders for the same customer saved together each
  // rewrite the products array, so the write is conditional on updatedAt.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await mergeProducts(customerId, items, refresh)) return;
  }
  console.error(`Saving products for customer ${customerId} kept colliding with other saves; skipped`);
}

// Newest products are kept; the oldest drop off once a customer passes this.
const MAX_SAVED_PRODUCTS = 150;

async function mergeProducts(customerId, items, refresh) {
  const customer = await customerRepo.findById(customerId);
  if (!customer) return true;

  const existing = [...(customer.products || [])].map((product) => (product?.toObject ? product.toObject() : product));
  const known = new Map(existing.map((product, index) => [productKey(product), index]).filter(([key]) => key));
  let changed = false;

  for (const item of items) {
    const name = String(item?.product || '').trim();
    if (!name) continue;
    const key = productKey(item);
    if (!key || (known.has(key) && !refresh)) continue;

    const { normalizeItem } = require('../salesOrder/salesOrder.service');
    const plain = item?.toObject ? item.toObject() : item;
    const spec = normalizeItem(plain);
    delete spec.currentStage;
    delete spec.stageWork;
    delete spec.stagePickup;
    delete spec.amount;
    delete spec._id;
    if (known.has(key)) {
      const index = known.get(key);
      existing[index] = { ...spec, _id: existing[index]._id };
    } else {
      existing.push(spec);
      known.set(key, existing.length - 1);
    }
    changed = true;
  }

  if (!changed) return true;
  const kept = existing.length > MAX_SAVED_PRODUCTS ? existing.slice(-MAX_SAVED_PRODUCTS) : existing;
  const Customer = require('./customer.model');
  const result = await Customer.updateOne(
    { _id: customerId, updatedAt: customer.updatedAt },
    { $set: { products: kept } },
    { runValidators: true }
  );
  return result.matchedCount > 0;
}

// Adds chosen products to a customer's list (draft order convert). Each one
// goes through the same checks as the Customers screen; one that fails or is
// already on the list is reported, never thrown. Returns
// [{ product, status: 'added' | 'exists' | 'failed', reason }].
async function addCustomerProducts(customerId, items) {
  const Customer = require('./customer.model');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const customer = await customerRepo.findById(customerId);
    if (!customer) return items.map((item) => ({ product: item?.product || '', status: 'failed', reason: 'Customer not found' }));
    const existing = [...(customer.products || [])].map((product) => (product?.toObject ? product.toObject() : product));
    // Same code, or the same name, counts as already saved.
    const nameKey = (item) => `name:${String(item?.product || '').trim().toLowerCase()}`;
    const known = new Set([...existing.map(productKey), ...existing.map(nameKey)].filter(Boolean));
    const results = [];
    for (const item of items) {
      const product = String(item?.product || '').trim();
      const key = productKey(item);
      if (!key) {
        results.push({ product, status: 'failed', reason: 'No product name' });
        continue;
      }
      if (known.has(key) || known.has(nameKey(item))) {
        results.push({ product, status: 'exists' });
        continue;
      }
      try {
        const [spec] = normalizeCustomerProducts([item]);
        delete spec.stagePickup;
        delete spec._id;
        existing.push(spec);
        known.add(key);
        known.add(nameKey(item));
        results.push({ product, status: 'added' });
      } catch (error) {
        results.push({ product, status: 'failed', reason: error.message });
      }
    }
    if (!results.some((r) => r.status === 'added')) return results;
    const kept = existing.length > MAX_SAVED_PRODUCTS ? existing.slice(-MAX_SAVED_PRODUCTS) : existing;
    const saved = await Customer.updateOne({ _id: customerId, updatedAt: customer.updatedAt }, { $set: { products: kept } }, { runValidators: true });
    if (saved.matchedCount) return results;
  }
  return items.map((item) => ({ product: item?.product || '', status: 'failed', reason: 'The customer was being changed at the same time; add it from the Customers screen' }));
}

async function deleteCustomer(id) {
  const customer = await customerRepo.findById(id);
  if (!customer) {
    throw new ApiError(404, 'Customer not found');
  }
  const used = await SalesOrder.countDocuments({ customer: id });
  if (used > 0) {
    throw new ApiError(400, 'Customer is used on an order and cannot be deleted');
  }
  await customerRepo.deleteById(id);
}

module.exports = {
  toPublicCustomer,
  snapshotFromCustomer,
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  attachProductsFromOrder,
  addCustomerProducts,
  deleteCustomer,
};
