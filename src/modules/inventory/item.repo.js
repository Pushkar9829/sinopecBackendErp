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

function takeQuantity(id, qty) {
  return InventoryItem.findOneAndUpdate(
    { _id: id, quantity: { $gte: qty - 1e-9 } },
    { $inc: { quantity: -qty } },
    { new: true }
  );
}

function addQuantity(id, qty) {
  return InventoryItem.findByIdAndUpdate(id, { $inc: { quantity: qty } }, { new: true });
}

function retireOrderLots(orderId, note) {
  return InventoryItem.updateMany({ salesOrder: orderId, kind: 'wip', category: 'output', isActive: true }, [
    { $set: { isActive: false, notes: { $trim: { input: { $concat: ['$notes', ' · ', note] } } } } },
  ]);
}

module.exports = {
  takeQuantity,
  addQuantity,
  retireOrderLots,
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
