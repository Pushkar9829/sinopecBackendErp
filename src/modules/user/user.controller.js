const asyncHandler = require('../../utils/asyncHandler');
const userService = require('./user.service');

const list = asyncHandler(async (req, res) => {
  const users = await userService.listUsers();
  res.json({ success: true, data: users });
});

const directory = asyncHandler(async (req, res) => {
  const users = await userService.listDirectory();
  res.json({ success: true, data: users });
});

const create = asyncHandler(async (req, res) => {
  const user = await userService.createUser(req.user, req.body);
  res.status(201).json({ success: true, data: user });
});

const update = asyncHandler(async (req, res) => {
  const user = await userService.updateUser(req.user, req.params.id, req.body);
  res.json({ success: true, data: user });
});

const remove = asyncHandler(async (req, res) => {
  await userService.deleteUser(req.user, req.params.id);
  res.json({ success: true, message: 'User deleted' });
});

module.exports = {
  list,
  directory,
  create,
  update,
  remove,
};
