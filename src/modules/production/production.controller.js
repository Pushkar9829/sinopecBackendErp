const asyncHandler = require('../../utils/asyncHandler');
const productionService = require('./production.service');

const listQueue = asyncHandler(async (req, res) => {
  const data = await productionService.listQueue(req.user, req.query.stage);
  res.json({ success: true, data });
});

const completeStage = asyncHandler(async (req, res) => {
  const order = await productionService.completeStage(req.user, req.body);
  res.json({ success: true, data: order });
});

const pickupLot = asyncHandler(async (req, res) => {
  const data = await productionService.pickupLot(req.user, req.body);
  res.json({ success: true, data });
});

const releasePickup = asyncHandler(async (req, res) => {
  const data = await productionService.releasePickup(req.user, req.body);
  res.json({ success: true, data });
});

const stageMachines = asyncHandler(async (req, res) => {
  const data = await productionService.stageMachines(req.user, req.params.stage);
  res.json({ success: true, data });
});

module.exports = {
  listQueue,
  completeStage,
  pickupLot,
  releasePickup,
  stageMachines,
};
