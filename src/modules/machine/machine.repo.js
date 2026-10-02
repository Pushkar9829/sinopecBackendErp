const Machine = require('./machine.model');

function findAll() {
  return Machine.find().sort({ name: 1 });
}

function findById(id) {
  return Machine.findById(id);
}

function findByIds(ids) {
  return Machine.find({ _id: { $in: ids } });
}

function findByCode(code) {
  if (!code) return null;
  const escaped = String(code).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Machine.findOne({ code: new RegExp(`^${escaped}$`, 'i') });
}

function create(data) {
  return Machine.create(data);
}

function updateById(id, data) {
  return Machine.findByIdAndUpdate(id, { $set: data }, { new: true });
}

function deleteById(id) {
  return Machine.findByIdAndDelete(id);
}

function countAll() {
  return Machine.countDocuments();
}

module.exports = {
  findAll,
  findById,
  findByIds,
  findByCode,
  create,
  updateById,
  deleteById,
  countAll,
};
