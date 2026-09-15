const { ROLE_SLUGS } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const permissionRepo = require('../permission/permission.repo');
const roleRepo = require('./role.repo');

async function listRoles() {
  return roleRepo.findAllWithPermissions();
}

async function updateRolePermissions(roleId, permissionIds) {
  const role = await roleRepo.findById(roleId);
  if (!role) {
    throw new ApiError(404, 'Role not found');
  }

  if (role.slug === ROLE_SLUGS.SUPER_ADMIN) {
    throw new ApiError(400, 'Super Admin permissions cannot be changed');
  }

  const uniqueIds = [...new Set(permissionIds)];
  const permissions = await permissionRepo.findByIds(uniqueIds);
  if (permissions.length !== uniqueIds.length) {
    throw new ApiError(400, 'One or more permission ids are invalid');
  }

  return roleRepo.updatePermissions(roleId, uniqueIds);
}

module.exports = {
  listRoles,
  updateRolePermissions,
};
