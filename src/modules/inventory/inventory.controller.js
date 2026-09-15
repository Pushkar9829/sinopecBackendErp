const asyncHandler = require('../../utils/asyncHandler');
const stageService = require('./stage.service');
const itemService = require('./item.service');

const listStages = asyncHandler(async (req, res) => {
  const stages = await stageService.listStages();
  res.json({ success: true, data: stages });
});

const getStage = asyncHandler(async (req, res) => {
  const stage = await stageService.getStage(req.params.id);
  res.json({ success: true, data: stage });
});

const createStage = asyncHandler(async (req, res) => {
  const stage = await stageService.createStage(req.body);
  res.status(201).json({ success: true, data: stage });
});

const updateStage = asyncHandler(async (req, res) => {
  const stage = await stageService.updateStage(req.params.id, req.body);
  res.json({ success: true, data: stage });
});

const removeStage = asyncHandler(async (req, res) => {
  await stageService.deleteStage(req.params.id);
  res.json({ success: true, message: 'Stage deleted' });
});

const listItems = asyncHandler(async (req, res) => {
  const items = await itemService.listItems(req.query);
  res.json({ success: true, data: items });
});

const getItem = asyncHandler(async (req, res) => {
  const item = await itemService.getItem(req.params.id);
  res.json({ success: true, data: item });
});

const createItem = asyncHandler(async (req, res) => {
  const item = await itemService.createItem(req.body);
  res.status(201).json({ success: true, data: item });
});

const updateItem = asyncHandler(async (req, res) => {
  const item = await itemService.updateItem(req.params.id, req.body);
  res.json({ success: true, data: item });
});

const removeItem = asyncHandler(async (req, res) => {
  await itemService.deleteItem(req.params.id);
  res.json({ success: true, message: 'Material deleted' });
});

const meta = asyncHandler(async (req, res) => {
  const data = await itemService.getMeta();
  res.json({ success: true, data });
});

module.exports = {
  listStages,
  getStage,
  createStage,
  updateStage,
  removeStage,
  listItems,
  getItem,
  createItem,
  updateItem,
  removeItem,
  meta,
};
