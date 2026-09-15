const InventoryStage = require('./stage.model');

const assignmentPopulate = [
  { path: 'machines', select: 'name code isActive notes' },
  { path: 'users', select: 'fullName username isActive role', populate: { path: 'role', select: 'name slug' } },
];

function findAll() {
  return InventoryStage.find().populate(assignmentPopulate).sort({ sortOrder: 1, name: 1 });
}

function findById(id) {
  return InventoryStage.findById(id).populate(assignmentPopulate);
}

function findBySlug(slug) {
  return InventoryStage.findOne({ slug }).populate(assignmentPopulate);
}

function create(data) {
  return InventoryStage.create(data);
}

function updateById(id, data) {
  return InventoryStage.findByIdAndUpdate(id, { $set: data }, { new: true }).populate(assignmentPopulate);
}

function deleteById(id) {
  return InventoryStage.findByIdAndDelete(id);
}

function upsertBySlug(data) {
  return InventoryStage.findOneAndUpdate(
    { slug: data.slug },
    { $set: { name: data.name, sortOrder: data.sortOrder } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

function countByMachine(machineId) {
  return InventoryStage.countDocuments({ machines: machineId });
}

module.exports = {
  findAll,
  findById,
  findBySlug,
  create,
  updateById,
  deleteById,
  upsertBySlug,
  countByMachine,
};
