const Register = require('./register.model');

function findByOrderId(orderId) {
  return Register.findOne({ salesOrder: orderId });
}

// { lean: true } for list screens: plain objects, no save(). ensureRegister
// loads a real document only for a register that actually needs updating.
function findByOrderIds(orderIds, { lean = false } = {}) {
  const query = Register.find({ salesOrder: { $in: orderIds } });
  return lean ? query.lean() : query;
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
