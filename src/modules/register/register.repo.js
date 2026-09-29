const Register = require('./register.model');

function findByOrderId(orderId) {
  return Register.findOne({ salesOrder: orderId });
}

function findByOrderIds(orderIds) {
  return Register.find({ salesOrder: { $in: orderIds } });
}

function create(data) {
  return Register.create(data);
}

function save(doc) {
  return doc.save();
}

module.exports = {
  findByOrderId,
  findByOrderIds,
  create,
  save,
};
