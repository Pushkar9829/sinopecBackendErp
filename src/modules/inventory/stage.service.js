const ApiError = require('../../utils/ApiError');
const stageRepo = require('./stage.repo');
const itemRepo = require('./item.repo');
const machineRepo = require('../machine/machine.repo');
const userRepo = require('../user/user.repo');

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function toPublicUserLite(user) {
  if (!user) return null;
  return {
    id: String(user._id),
    fullName: user.fullName,
    username: user.username,
    isActive: user.isActive,
    role: user.role
      ? {
          id: String(user.role._id || user.role),
          name: user.role.name,
          slug: user.role.slug,
        }
      : null,
  };
}

function toPublicMachineLite(machine) {
  if (!machine) return null;
  return {
    id: String(machine._id),
    name: machine.name,
    code: machine.code || '',
    isActive: machine.isActive,
  };
}

function toPublicStage(stage) {
  const machines = (stage.machines || [])
    .map((machine) => (machine && machine.name ? toPublicMachineLite(machine) : null))
    .filter(Boolean);
  const users = (stage.users || [])
    .map((user) => (user && user.fullName ? toPublicUserLite(user) : null))
    .filter(Boolean);

  return {
    id: String(stage._id),
    name: stage.name,
    slug: stage.slug,
    sortOrder: stage.sortOrder,
    isActive: stage.isActive,
    machines,
    users,
  };
}

async function listStages() {
  const stages = await stageRepo.findAll();
  return stages.map(toPublicStage);
}

async function getStage(id) {
  const stage = await stageRepo.findById(id);
  if (!stage) {
    throw new ApiError(404, 'Stage not found');
  }
  return toPublicStage(stage);
}

async function createStage(payload) {
  const name = payload.name.trim();
  const slug = slugify(name);
  if (!slug) {
    throw new ApiError(400, 'Enter a valid stage name');
  }

  const existing = await stageRepo.findBySlug(slug);
  if (existing) {
    throw new ApiError(409, 'A stage with this name already exists');
  }

  const stage = await stageRepo.create({
    name,
    slug,
    sortOrder: Number(payload.sortOrder) || 0,
    isActive: payload.isActive !== false,
  });
  return getStage(stage._id);
}

async function resolveIds(ids, finder, label) {
  const unique = [...new Set((ids || []).map(String))];
  if (!unique.length) return [];
  const docs = await finder(unique);
  if (docs.length !== unique.length) {
    throw new ApiError(400, `One or more ${label} ids are invalid`);
  }
  return unique;
}

async function updateStage(id, payload) {
  const stage = await stageRepo.findById(id);
  if (!stage) {
    throw new ApiError(404, 'Stage not found');
  }

  const updates = {};
  if (payload.name !== undefined) {
    updates.name = payload.name.trim();
    updates.slug = slugify(updates.name);
    if (!updates.slug) {
      throw new ApiError(400, 'Enter a valid stage name');
    }
    const existing = await stageRepo.findBySlug(updates.slug);
    if (existing && String(existing._id) !== String(id)) {
      throw new ApiError(409, 'A stage with this name already exists');
    }
  }
  if (payload.sortOrder !== undefined) updates.sortOrder = Number(payload.sortOrder) || 0;
  if (payload.isActive !== undefined) updates.isActive = payload.isActive;
  if (payload.machineIds) {
    updates.machines = await resolveIds(payload.machineIds, (ids) => machineRepo.findByIds(ids), 'machine');
  }
  if (payload.userIds) {
    updates.users = await resolveIds(payload.userIds, (ids) => userRepo.findByIds(ids), 'user');
  }

  await stageRepo.updateById(id, updates);
  return getStage(id);
}

async function deleteStage(id) {
  const stage = await stageRepo.findById(id);
  if (!stage) {
    throw new ApiError(404, 'Stage not found');
  }

  const inUse = await itemRepo.countByStage(id);
  if (inUse > 0) {
    throw new ApiError(400, 'Cannot delete a stage that still has materials');
  }

  await stageRepo.deleteById(id);
}

module.exports = {
  listStages,
  getStage,
  createStage,
  updateStage,
  deleteStage,
  toPublicStage,
};
