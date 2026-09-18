const ApiError = require('../../utils/ApiError');
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

function toPublicProduct(product) {
  // Lazy require avoids circular import with salesOrder.service
  const { normalizeItem } = require('../salesOrder/salesOrder.service');
  const spec = normalizeItem(product);
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
    if (raw._id || raw.id) spec._id = raw._id || raw.id;
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

async function listCustomers() {
  const customers = await customerRepo.findAll();
  return customers.map(toPublicCustomer);
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
  data.isActive = payload.isActive !== false;
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
  if (payload.isActive !== undefined) data.isActive = payload.isActive;
  if (payload.products !== undefined) {
    data.products = normalizeCustomerProducts(payload.products);
  }

  const updated = await customerRepo.updateById(id, data);
  return toPublicCustomer(updated);
}

async function attachProductsFromOrder(customerId, items) {
  if (!customerId || !Array.isArray(items) || !items.length) return;

  const customer = await customerRepo.findById(customerId);
  if (!customer) return;

  const existing = [...(customer.products || [])];
  const known = new Set(existing.map(productKey).filter(Boolean));
  let changed = false;

  for (const item of items) {
    const name = String(item?.product || '').trim();
    if (!name) continue;
    const key = productKey(item);
    if (!key || known.has(key)) continue;

    const { normalizeItem } = require('../salesOrder/salesOrder.service');
    const spec = normalizeItem(item);
    delete spec.currentStage;
    delete spec.stageWork;
    delete spec.amount;
    delete spec._id;
    existing.push(spec);
    known.add(key);
    changed = true;
  }

  if (changed) {
    await customerRepo.updateById(customerId, { products: existing });
  }
}

async function deleteCustomer(id) {
  const customer = await customerRepo.findById(id);
  if (!customer) {
    throw new ApiError(404, 'Customer not found');
  }
  const used = await SalesOrder.countDocuments({ customer: id });
  if (used > 0) {
    throw new ApiError(400, 'Customer is used on a sales order and cannot be deleted');
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
