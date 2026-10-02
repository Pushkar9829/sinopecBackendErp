const mongoose = require('mongoose');
const { INVENTORY_CATEGORIES, ORDER_TYPES, SALES_ORDER_STATUSES } = require('../../config/constants');
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
    canDelete: !(
      item.kind === 'wip' &&
      item.category !== INVENTORY_CATEGORIES.WASTE &&
      item.isActive !== false &&
      Number(item.quantity) > 0
    ),
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
    return null;
  }
  const price = Number(unitPrice);
  if (Number.isNaN(price) || price < 0) {
    throw new ApiError(400, 'Unit price must be a number 0 or greater');
  }
  return price;
}

function text(value, label, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, `${label} is required`);
    return '';
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ApiError(400, `${label} must be text`);
  }
  const out = String(value).trim();
  if (required && !out) throw new ApiError(400, `${label} is required`);
  return out;
}

function quantityOf(value) {
  const qty = Number(value);
  if (!Number.isFinite(qty) || qty < 0) throw new ApiError(400, 'Quantity must be a number 0 or greater');
  return qty;
}

async function listItems(query = {}) {
  const filter = {};
  if (query.category) {
    if (!Object.values(INVENTORY_CATEGORIES).includes(query.category)) {
      throw new ApiError(400, 'Category must be raw, output, or waste');
    }
    filter.category = query.category;
  }
  if (query.stageId) {
    if (!mongoose.isValidObjectId(query.stageId)) throw new ApiError(400, 'Invalid stage');
    filter.stage = query.stageId;
  }
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

// Customer material for a job work is stored as a raw lot linked to that order; recording it closes the "receive material" task.
async function resolveJobWork(category, salesOrderId) {
  const id = salesOrderId ? String(salesOrderId).trim() : '';
  if (!id) return null;
  if (category !== INVENTORY_CATEGORIES.RAW) throw new ApiError(400, 'Only raw material can be linked to a job work');
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'Invalid job work');
  const order = await require('../salesOrder/salesOrder.repo').findById(id);
  if (!order) throw new ApiError(404, 'Job work not found');
  if (order.orderType !== ORDER_TYPES.JOB_WORK) throw new ApiError(400, `${order.number} is not a job work`);
  if ([SALES_ORDER_STATUSES.CANCELLED, SALES_ORDER_STATUSES.COMPLETED].includes(order.status)) {
    throw new ApiError(400, `${order.number} is ${order.status}`);
  }
  return order;
}

async function syncLinkedOrder(orderId, user) {
  if (!orderId) return;
  const order = await require('../salesOrder/salesOrder.repo').findById(orderId);
  if (order) await require('../task/task.hooks').syncOrder(order, user);
}

async function createItem(payload, user = null) {
  const category = payload.category;
  if (!Object.values(INVENTORY_CATEGORIES).includes(category)) {
    throw new ApiError(400, 'Category must be raw, output, or waste');
  }

  const jobWork = await resolveJobWork(category, payload.salesOrderId);
  const stage = await assertStage(category, payload.stageId);
  const item = await itemRepo.create({
    category,
    name: text(payload.name, 'Name', { required: true }),
    materialType: text(payload.materialType, 'Material type', { required: true }),
    unit: text(payload.unit, 'Unit', { required: true }),
    quantity: quantityOf(payload.quantity ?? 0),
    unitPrice: normalizePrice(category, payload.unitPrice),
    stage,
    notes: text(payload.notes, 'Notes'),
    isActive: payload.isActive !== false,
    salesOrder: jobWork?._id || null,
  });

  await syncLinkedOrder(jobWork?._id, user);
  const created = await itemRepo.findById(item._id);
  return toPublicItem(created);
}

async function updateItem(id, payload, user = null) {
  const item = await itemRepo.findById(id);
  if (!item) {
    throw new ApiError(404, 'Material not found');
  }

  if (item.kind === 'wip') {
    const updated = await itemRepo.updateById(id, { notes: text(payload.notes ?? item.notes, 'Notes') });
    return toPublicItem(updated);
  }

  const category = payload.category || item.category;
  if (!Object.values(INVENTORY_CATEGORIES).includes(category)) {
    throw new ApiError(400, 'Category must be raw, output, or waste');
  }

  const updates = { category };
  if (payload.name !== undefined) updates.name = text(payload.name, 'Name', { required: true });
  if (payload.materialType !== undefined) updates.materialType = text(payload.materialType, 'Material type', { required: true });
  if (payload.unit !== undefined) updates.unit = text(payload.unit, 'Unit', { required: true });
  if (payload.quantity !== undefined) updates.quantity = quantityOf(payload.quantity);
  if (payload.notes !== undefined) updates.notes = text(payload.notes, 'Notes');
  if (payload.isActive !== undefined) updates.isActive = Boolean(payload.isActive);

  const stageId = payload.stageId !== undefined ? payload.stageId : item.stage?._id || item.stage;
  updates.stage = await assertStage(category, stageId);
  updates.unitPrice = normalizePrice(
    category,
    payload.unitPrice !== undefined ? payload.unitPrice : item.unitPrice
  );

  const previousLink = item.salesOrder?._id || item.salesOrder || null;
  let linkedTo = null;
  if (payload.salesOrderId !== undefined && String(payload.salesOrderId || '') !== String(previousLink || '')) {
    const jobWork = await resolveJobWork(category, payload.salesOrderId);
    updates.salesOrder = jobWork?._id || null;
    linkedTo = jobWork?._id || null;
  } else if (previousLink && category !== INVENTORY_CATEGORIES.RAW) {
    updates.salesOrder = null;
  }

  const updated = await itemRepo.updateById(id, updates);
  await syncLinkedOrder(linkedTo, user);
  const quantityChanged = updates.quantity !== undefined && updates.quantity !== item.quantity;
  const activeChanged = updates.isActive !== undefined && updates.isActive !== item.isActive;
  if (previousLink && (String(updates.salesOrder ?? previousLink) !== String(previousLink) || quantityChanged || activeChanged)) {
    await syncLinkedOrder(previousLink, user);
  }
  return toPublicItem(updated);
}

async function assertNotInUse(item) {
  const SalesOrder = require('../salesOrder/salesOrder.model');
  const using = await SalesOrder.findOne({
    status: { $nin: [SALES_ORDER_STATUSES.CANCELLED, SALES_ORDER_STATUSES.COMPLETED] },
    $or: [{ 'items.stagePickup.lot': item._id }, { 'items.stageWork.sourceLot': item._id }],
  }).select('number');
  if (using) {
    throw new ApiError(400, `${using.number} has taken material from this lot. Set it inactive instead of deleting it.`);
  }
}

async function deleteItem(id) {
  const item = await itemRepo.findById(id);
  if (!item) {
    throw new ApiError(404, 'Material not found');
  }
  const floorOutput = item.kind === 'wip' && item.category !== INVENTORY_CATEGORIES.WASTE;
  if (floorOutput && item.isActive !== false && Number(item.quantity) > 0) {
    throw new ApiError(400, 'This lot belongs to an order on the floor. It is used up by the next stage.');
  }
  if (item.kind !== 'wip') await assertNotInUse(item);
  await itemRepo.deleteById(id);
  await syncLinkedOrder(item.salesOrder?._id || item.salesOrder, null).catch(() => {});
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
