const { INVENTORY_CATEGORIES } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const itemRepo = require('./item.repo');
const stageRepo = require('./stage.repo');
const { toPublicStage } = require('./stage.service');

function toPublicItem(item) {
  return {
    id: String(item._id),
    category: item.category,
    name: item.name,
    materialType: item.materialType,
    unit: item.unit,
    quantity: item.quantity,
    unitPrice: item.category === INVENTORY_CATEGORIES.WASTE ? null : item.unitPrice,
    notes: item.notes || '',
    isActive: item.isActive,
    kind: item.kind || 'catalog',
    wipStage: item.wipStage || '',
    salesOrderId: item.salesOrder ? String(item.salesOrder) : '',
    stage: item.stage ? toPublicStage(item.stage) : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

async function assertStage(category, stageId) {
  const needsStage = category === INVENTORY_CATEGORIES.OUTPUT || category === INVENTORY_CATEGORIES.WASTE;
  if (!needsStage) {
    return null;
  }
  if (!stageId) {
    throw new ApiError(400, 'Stage is required for output and waste materials');
  }
  const stage = await stageRepo.findById(stageId);
  if (!stage) {
    throw new ApiError(400, 'Stage not found');
  }
  return stage._id;
}

function normalizePrice(category, unitPrice) {
  if (category === INVENTORY_CATEGORIES.WASTE) {
    return null;
  }
  if (unitPrice === undefined || unitPrice === null || unitPrice === '') {
    throw new ApiError(400, 'Unit price is required for raw and output materials');
  }
  const price = Number(unitPrice);
  if (Number.isNaN(price) || price < 0) {
    throw new ApiError(400, 'Unit price must be a number 0 or greater');
  }
  return price;
}

async function listItems(query = {}) {
  const filter = {};
  if (query.category) filter.category = query.category;
  if (query.stageId) filter.stage = query.stageId;
  const items = await itemRepo.findAll(filter);
  return items.map(toPublicItem);
}

async function getItem(id) {
  const item = await itemRepo.findById(id);
  if (!item) {
    throw new ApiError(404, 'Material not found');
  }
  return toPublicItem(item);
}

async function createItem(payload) {
  const category = payload.category;
  if (!Object.values(INVENTORY_CATEGORIES).includes(category)) {
    throw new ApiError(400, 'Category must be raw, output, or waste');
  }

  const stage = await assertStage(category, payload.stageId);
  const item = await itemRepo.create({
    category,
    name: payload.name.trim(),
    materialType: payload.materialType.trim(),
    unit: payload.unit.trim(),
    quantity: Number(payload.quantity) || 0,
    unitPrice: normalizePrice(category, payload.unitPrice),
    stage,
    notes: payload.notes?.trim() || '',
    isActive: payload.isActive !== false,
  });

  const created = await itemRepo.findById(item._id);
  return toPublicItem(created);
}

async function updateItem(id, payload) {
  const item = await itemRepo.findById(id);
  if (!item) {
    throw new ApiError(404, 'Material not found');
  }

  const category = payload.category || item.category;
  if (!Object.values(INVENTORY_CATEGORIES).includes(category)) {
    throw new ApiError(400, 'Category must be raw, output, or waste');
  }

  const updates = { category };
  if (payload.name !== undefined) updates.name = payload.name.trim();
  if (payload.materialType !== undefined) updates.materialType = payload.materialType.trim();
  if (payload.unit !== undefined) updates.unit = payload.unit.trim();
  if (payload.quantity !== undefined) updates.quantity = Number(payload.quantity) || 0;
  if (payload.notes !== undefined) updates.notes = payload.notes.trim();
  if (payload.isActive !== undefined) updates.isActive = payload.isActive;

  const stageId = payload.stageId !== undefined ? payload.stageId : item.stage?._id || item.stage;
  updates.stage = await assertStage(category, stageId);
  updates.unitPrice = normalizePrice(
    category,
    payload.unitPrice !== undefined ? payload.unitPrice : item.unitPrice
  );

  const updated = await itemRepo.updateById(id, updates);
  return toPublicItem(updated);
}

async function deleteItem(id) {
  const item = await itemRepo.findById(id);
  if (!item) {
    throw new ApiError(404, 'Material not found');
  }
  await itemRepo.deleteById(id);
}

async function getMeta() {
  const [materialTypes, units] = await Promise.all([
    itemRepo.distinctValues('materialType'),
    itemRepo.distinctValues('unit'),
  ]);
  return {
    materialTypes: materialTypes.filter(Boolean).sort(),
    units: units.filter(Boolean).sort(),
  };
}

module.exports = {
  listItems,
  getItem,
  createItem,
  updateItem,
  deleteItem,
  getMeta,
};
