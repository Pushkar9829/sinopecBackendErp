const ApiError = require('../../utils/ApiError');
const { toBool } = require('../../utils/permissions');
const { storeListPhotos } = require('../../utils/inlineImages');
const { nextCustomerCode } = require('../../utils/counter');
const customerRepo = require('./customer.repo');
const SalesOrder = require('../salesOrder/salesOrder.model');

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
    productionRoute: spec.productionRoute,
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

function normalizeCustomerProducts(list) {
  if (!Array.isArray(list)) return [];
  const { normalizeItem } = require('../salesOrder/salesOrder.service');
  const products = [];
  for (const raw of list) {
    const name = String(raw?.product || '').trim();
    if (!name) continue;
    const spec = normalizeItem(raw);
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
    billingAddress: customer.billingAddress || '',
    shippingAddress: customer.shippingAddress || '',
    priceCategory: customer.priceCategory || '',
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
    billingAddress: customer.billingAddress || '',
    shippingAddress: customer.shippingAddress || '',
    priceCategory: customer.priceCategory || '',
  };
}

function trim(value) {
  return value == null ? '' : String(value).trim();
}

function payloadFromBody(payload) {
  return {
    name: trim(payload.name),
    companyName: trim(payload.companyName),
    contactPerson: trim(payload.contactPerson),
    mobile: trim(payload.mobile),
    email: trim(payload.email),
    gstNumber: trim(payload.gstNumber),
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

async function createCustomer(payload) {
  const data = payloadFromBody(payload);
  if (!data.name) {
    throw new ApiError(400, 'Customer name is required');
  }
  data.code = await nextCustomerCode();
  data.isActive = payload.isActive === undefined ? true : toBool(payload.isActive);
  await storeListPhotos(payload.products);
  data.products = normalizeCustomerProducts(payload.products);
  const customer = await customerRepo.create(data);
  return toPublicCustomer(customer);
}

async function updateCustomer(id, payload) {
  const customer = await customerRepo.findById(id);
  if (!customer) {
    throw new ApiError(404, 'Customer not found');
  }

  const data = payloadFromBody({ ...customer.toObject(), ...payload });
  if (!data.name) {
    throw new ApiError(400, 'Customer name is required');
  }
  if (payload.isActive !== undefined) data.isActive = toBool(payload.isActive);
  if (payload.products !== undefined && payload.products !== null) {
    if (!Array.isArray(payload.products)) {
      throw new ApiError(400, 'Products must be a list');
    }
    await storeListPhotos(payload.products);
    data.products = normalizeCustomerProducts(payload.products);
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
  deleteCustomer,
};
