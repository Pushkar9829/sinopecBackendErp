const permissionRepo = require('./permission.repo');

async function listPermissions() {
  return permissionRepo.findAll();
}

module.exports = {
  listPermissions,
};
