const asyncHandler = require('../../utils/asyncHandler');
const roleService = require('./role.service');

const list = asyncHandler(async (req, res) => {
  const roles = await roleService.listRoles();
  res.json({ success: true, data: roles });
});

const updatePermissions = asyncHandler(async (req, res) => {
  const role = await roleService.updateRolePermissions(req.params.id, req.body.permissionIds);
  res.json({ success: true, data: role });
});

module.exports = {
  list,
  updatePermissions,
};
