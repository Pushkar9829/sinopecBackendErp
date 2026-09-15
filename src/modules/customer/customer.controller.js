const asyncHandler = require('../../utils/asyncHandler');
const customerService = require('./customer.service');

const list = asyncHandler(async (req, res) => {
  const customers = await customerService.listCustomers();
  res.json({ success: true, data: customers });
});

const getOne = asyncHandler(async (req, res) => {
  const customer = await customerService.getCustomer(req.params.id);
  res.json({ success: true, data: customer });
});

const create = asyncHandler(async (req, res) => {
  const customer = await customerService.createCustomer(req.body);
  res.status(201).json({ success: true, data: customer });
});

const update = asyncHandler(async (req, res) => {
  const customer = await customerService.updateCustomer(req.params.id, req.body);
  res.json({ success: true, data: customer });
});

const remove = asyncHandler(async (req, res) => {
  await customerService.deleteCustomer(req.params.id);
  res.json({ success: true, message: 'Customer deleted' });
});

module.exports = {
  list,
  getOne,
  create,
  update,
  remove,
};
