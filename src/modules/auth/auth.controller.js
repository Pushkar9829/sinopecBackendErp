const asyncHandler = require('../../utils/asyncHandler');
const authService = require('./auth.service');

const login = asyncHandler(async (req, res) => {
  const user = await authService.login(res, req.body.username, req.body.password);
  res.json({ success: true, data: user });
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout(req, res);
  res.json({ success: true, message: 'Logged out' });
});

const refresh = asyncHandler(async (req, res) => {
  const user = await authService.refresh(req, res);
  res.json({ success: true, data: user });
});

const me = asyncHandler(async (req, res) => {
  res.json({ success: true, data: authService.me(req.user) });
});

module.exports = {
  login,
  logout,
  refresh,
  me,
};
