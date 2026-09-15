const InventoryItem = require('./item.model');

function findAll(filter = {}) {
  return InventoryItem.find(filter).populate('stage').sort({ createdAt: -1 });
}

function findById(id) {
  return InventoryItem.findById(id).populate('stage');
}

function findOne(filter = {}) {
  return InventoryItem.findOne(filter).populate('stage');
}

function create(data) {
  return InventoryItem.create(data);
}

function updateById(id, data) {
  return InventoryItem.findByIdAndUpdate(id, { $set: data }, { new: true }).populate('stage');
}

function deleteById(id) {
  return InventoryItem.findByIdAndDelete(id);
}

function countByStage(stageId) {
  return InventoryItem.countDocuments({ stage: stageId });
}

function distinctValues(field) {
  return InventoryItem.distinct(field);
}

function countAll() {
  return InventoryItem.countDocuments();
}

module.exports = {
  findAll,
  findOne,
  findById,
  create,
  updateById,
  deleteById,
  countByStage,
  distinctValues,
  countAll,
};
