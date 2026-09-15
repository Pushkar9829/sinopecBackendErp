const ApiError = require('../../utils/ApiError');
const { nextCustomerCode } = require('../../utils/counter');
const customerRepo = require('./customer.repo');
const SalesOrder = require('../salesOrder/salesOrder.model');

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

  const updated = await customerRepo.updateById(id, data);
  return toPublicCustomer(updated);
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
  deleteCustomer,
};
