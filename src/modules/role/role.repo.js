const Role = require('./role.model');

function findAllWithPermissions() {
  return Role.find().populate('permissions').sort({ name: 1 });
}

function findById(id) {
  return Role.findById(id);
}

function findByIdWithPermissions(id) {
  return Role.findById(id).populate('permissions');
}

function findBySlug(slug) {
  return Role.findOne({ slug });
}

function upsertBySlug(data) {
  return Role.findOneAndUpdate(
    { slug: data.slug },
    { $set: data },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

function updatePermissions(id, permissionIds) {
  return Role.findByIdAndUpdate(
    id,
    { $set: { permissions: permissionIds } },
    { new: true }
  ).populate('permissions');
}

module.exports = {
  findAllWithPermissions,
  findById,
  findByIdWithPermissions,
  findBySlug,
  upsertBySlug,
  updatePermissions,
};
