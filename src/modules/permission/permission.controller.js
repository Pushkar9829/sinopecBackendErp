const asyncHandler = require('../../utils/asyncHandler');
const permissionService = require('./permission.service');

const list = asyncHandler(async (req, res) => {
  const permissions = await permissionService.listPermissions();
  res.json({ success: true, data: permissions });
});

module.exports = {
  list,
};
