const User = require('./user.model');

const rolePopulate = {
  path: 'role',
  populate: { path: 'permissions' },
};

function findAllWithRole() {
  return User.find().populate(rolePopulate).sort({ createdAt: -1 }).select('-passwordHash');
}

function findById(id) {
  return User.findById(id);
}

function findByIdWithRole(id) {
  return User.findById(id).populate(rolePopulate);
}

function findByUsername(username) {
  return User.findOne({ username: username.toLowerCase().trim() }).populate(rolePopulate);
}

function create(data) {
  return User.create(data);
}

function updateById(id, data) {
  return User.findByIdAndUpdate(id, { $set: data }, { new: true }).populate(rolePopulate);
}

function deleteById(id) {
  return User.findByIdAndDelete(id);
}

function countByRole(roleId) {
  return User.countDocuments({ role: roleId });
}

function findByIds(ids) {
  return User.find({ _id: { $in: ids } }).populate(rolePopulate).select('-passwordHash');
}

module.exports = {
  findAllWithRole,
  findById,
  findByIdWithRole,
  findByUsername,
  findByIds,
  create,
  updateById,
  deleteById,
  countByRole,
};
