const asyncHandler = require('../../utils/asyncHandler');
const taskService = require('./task.service');

const list = asyncHandler(async (req, res) => {
  const tasks = await taskService.listTasks(req.user, req.query);
  res.json({ success: true, data: tasks });
});

const summary = asyncHandler(async (req, res) => {
  const data = await taskService.getSummary(req.user);
  res.json({ success: true, data });
});

const assignees = asyncHandler(async (req, res) => {
  const data = await taskService.listAssignees();
  res.json({ success: true, data });
});

const forOrder = asyncHandler(async (req, res) => {
  const tasks = await taskService.listForOrder(req.user, req.params.orderId);
  res.json({ success: true, data: tasks });
});

const get = asyncHandler(async (req, res) => {
  const task = await taskService.getTask(req.user, req.params.id);
  res.json({ success: true, data: task });
});

const create = asyncHandler(async (req, res) => {
  const task = await taskService.createTask(req.user, req.body);
  res.status(201).json({ success: true, data: task });
});

const update = asyncHandler(async (req, res) => {
  const task = await taskService.updateTask(req.user, req.params.id, req.body);
  res.json({ success: true, data: task });
});

const claim = asyncHandler(async (req, res) => {
  const task = await taskService.claimTask(req.user, req.params.id);
  res.json({ success: true, data: task });
});

const comment = asyncHandler(async (req, res) => {
  const task = await taskService.addComment(req.user, req.params.id, req.body.text);
  res.status(201).json({ success: true, data: task });
});

module.exports = {
  list,
  summary,
  assignees,
  forOrder,
  get,
  create,
  update,
  claim,
  comment,
};
