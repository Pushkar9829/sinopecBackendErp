const Register = require('./register.model');

function findByOrderId(orderId) {
  return Register.findOne({ salesOrder: orderId });
}

function create(data) {
  return Register.create(data);
}

function save(doc) {
  return doc.save();
}

module.exports = {
  findByOrderId,
  create,
  save,
};
