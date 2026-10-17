const { ROLE_SLUGS } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { isSuperAdmin, permissionsBeyond } = require('../../utils/permissions');
const permissionRepo = require('../permission/permission.repo');
const roleRepo = require('./role.repo');

async function listRoles() {
  return roleRepo.findAllWithPermissions();
}

async function updateRolePermissions(actor, roleId, permissionIds) {
  const role = await roleRepo.findByIdWithPermissions(roleId);
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

  if (!isSuperAdmin(actor)) {
    if (String(actor.role?._id) === String(role._id)) {
      throw new ApiError(403, 'You cannot change the permissions of your own role');
    }
    if (permissionsBeyond(actor, role).length) {
      throw new ApiError(403, 'You cannot edit a role that has access you do not have');
    }
    const beyond = permissionsBeyond(actor, { permissions });
    if (beyond.length) {
      throw new ApiError(403, `You cannot grant access you do not have: ${beyond.join(', ')}`);
    }
  }

  return roleRepo.updatePermissions(roleId, uniqueIds);
}

module.exports = {
  listRoles,
  updateRolePermissions,
};
