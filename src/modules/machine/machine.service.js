const ApiError = require('../../utils/ApiError');
const machineRepo = require('./machine.repo');
const stageRepo = require('../inventory/stage.repo');

function toPublicMachine(machine) {
  return {
    id: String(machine._id),
    name: machine.name,
    code: machine.code || '',
    notes: machine.notes || '',
    isActive: machine.isActive,
  };
}

async function listMachines() {
  const machines = await machineRepo.findAll();
  return machines.map(toPublicMachine);
}

async function getMachine(id) {
  const machine = await machineRepo.findById(id);
  if (!machine) {
    throw new ApiError(404, 'Machine not found');
  }
  return toPublicMachine(machine);
}

async function createMachine(payload) {
  const name = payload.name.trim();
  const code = payload.code?.trim() || '';
  if (code) {
    const existing = await machineRepo.findByCode(code);
    if (existing) {
      throw new ApiError(409, 'A machine with this code already exists');
    }
  }

  const machine = await machineRepo.create({
    name,
    code,
    notes: payload.notes?.trim() || '',
    isActive: payload.isActive !== false,
  });
  return toPublicMachine(machine);
}

async function updateMachine(id, payload) {
  const machine = await machineRepo.findById(id);
  if (!machine) {
    throw new ApiError(404, 'Machine not found');
  }

  const updates = {};
  if (payload.name !== undefined) updates.name = payload.name.trim();
  if (payload.notes !== undefined) updates.notes = payload.notes.trim();
  if (payload.isActive !== undefined) updates.isActive = payload.isActive;
  if (payload.code !== undefined) {
    updates.code = payload.code.trim();
    if (updates.code) {
      const existing = await machineRepo.findByCode(updates.code);
      if (existing && String(existing._id) !== String(id)) {
        throw new ApiError(409, 'A machine with this code already exists');
      }
    }
  }

  const updated = await machineRepo.updateById(id, updates);
  return toPublicMachine(updated);
}

async function deleteMachine(id) {
  const machine = await machineRepo.findById(id);
  if (!machine) {
    throw new ApiError(404, 'Machine not found');
  }
  const inUse = await stageRepo.countByMachine(id);
  if (inUse > 0) {
    throw new ApiError(400, 'Cannot delete a machine assigned to a stage');
  }
  await machineRepo.deleteById(id);
}

module.exports = {
  toPublicMachine,
  listMachines,
  getMachine,
  createMachine,
  updateMachine,
  deleteMachine,
};
