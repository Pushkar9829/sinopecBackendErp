const Customer = require('./customer.model');

function findAll(filter = {}) {
  return Customer.find(filter).sort({ createdAt: -1 });
}

function findById(id) {
  return Customer.findById(id);
}

function findByCode(code) {
  return Customer.findOne({ code });
}

function create(data) {
  return Customer.create(data);
}

function updateById(id, data) {
  return Customer.findByIdAndUpdate(id, { $set: data }, { new: true });
}

function deleteById(id) {
  return Customer.findByIdAndDelete(id);
}

function countAll() {
  return Customer.countDocuments();
}

module.exports = {
  findAll,
  findById,
  findByCode,
  create,
  updateById,
  deleteById,
  countAll,
};
