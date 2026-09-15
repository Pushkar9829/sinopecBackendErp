const asyncHandler = require('../../utils/asyncHandler');
const machineService = require('./machine.service');

const list = asyncHandler(async (req, res) => {
  const machines = await machineService.listMachines();
  res.json({ success: true, data: machines });
});

const get = asyncHandler(async (req, res) => {
  const machine = await machineService.getMachine(req.params.id);
  res.json({ success: true, data: machine });
});

const create = asyncHandler(async (req, res) => {
  const machine = await machineService.createMachine(req.body);
  res.status(201).json({ success: true, data: machine });
});

const update = asyncHandler(async (req, res) => {
  const machine = await machineService.updateMachine(req.params.id, req.body);
  res.json({ success: true, data: machine });
});

const remove = asyncHandler(async (req, res) => {
  await machineService.deleteMachine(req.params.id);
  res.json({ success: true, message: 'Machine deleted' });
});

module.exports = {
  list,
  get,
  create,
  update,
  remove,
};
