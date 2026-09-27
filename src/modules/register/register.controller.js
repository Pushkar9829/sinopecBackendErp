const asyncHandler = require('../../utils/asyncHandler');
const registerService = require('./register.service');

const list = asyncHandler(async (req, res) => {
  const data = await registerService.list(req.user);
  res.json({ success: true, data });
});

const getByOrder = asyncHandler(async (req, res) => {
  const data = await registerService.getByOrder(req.user, req.params.orderId);
  res.json({ success: true, data });
});

const getStage = asyncHandler(async (req, res) => {
  const data = await registerService.getStage(req.user, req.params.stage);
  res.json({ success: true, data });
});

module.exports = {
  list,
  getByOrder,
  getStage,
};
