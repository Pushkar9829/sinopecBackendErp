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

const getArtwork = asyncHandler(async (req, res) => {
  const data = await registerService.getArtwork(req.user, req.params.orderId, req.params.itemId);
  res.json({ success: true, data });
});

const downloadArtwork = asyncHandler(async (req, res) => {
  const file = await registerService.getArtworkFile(req.user, req.params.orderId, req.params.attachmentId);
  if (file.redirectUrl) return res.redirect(file.redirectUrl);
  res.download(file.filePath, file.originalName);
});

module.exports = {
  getArtwork,
  downloadArtwork,
  list,
  getByOrder,
  getStage,
};
