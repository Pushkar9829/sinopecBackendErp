const { SALES_ORDER_STATUSES } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { hasPermission } = require('../../utils/permissions');
const salesOrderRepo = require('../salesOrder/salesOrder.repo');
const {
  FLOOR_STAGES,
  canReadStage,
  canWorkStage,
  itemVisibleAtStage,
  registerSpecs,
  routeStages,
  stageStats,
  stageUnit,
  visibleStages,
} = require('../production/production.flow');
const repo = require('./register.repo');

const REGISTER_STATUSES = [
  SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
  SALES_ORDER_STATUSES.IN_PRODUCTION,
  SALES_ORDER_STATUSES.READY_FOR_PACKING,
  SALES_ORDER_STATUSES.PACKED,
  SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
  SALES_ORDER_STATUSES.DISPATCHED,
  SALES_ORDER_STATUSES.DELIVERED,
  SALES_ORDER_STATUSES.COMPLETED,
];

function canViewBooks(user) {
  return (
    visibleStages(user).length > 0 ||
    hasPermission(user, 'sales:read') ||
    hasPermission(user, 'accounts:read') ||
    hasPermission(user, 'inventory:read')
  );
}

function assertCanView(user) {
  if (canViewBooks(user)) return;
  throw new ApiError(403, 'You cannot view the register');
}

function canReadBook(user, stage) {
  if (canReadStage(user, stage)) return true;
  return (
    hasPermission(user, 'sales:read') ||
    hasPermission(user, 'accounts:read') ||
    hasPermission(user, 'inventory:read')
  );
}

function stagesForOrder(order) {
  const ids = [];
  for (const item of order.items || []) {
    for (const stage of routeStages(item.productionRoute)) {
      if (!ids.includes(stage)) ids.push(stage);
    }
  }
  return ids;
}

function customerNameOf(order) {
  return order.customerSnapshot?.name || order.customer?.name || '';
}

function publicDetails(raw) {
  const source = raw && typeof raw.toObject === 'function' ? raw.toObject() : raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key || key.startsWith('_') || key.startsWith('$')) continue;
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue;
    out[key] = String(value);
  }
  return out;
}

function entryFromWork(item, row) {
  return {
    stage: row.stage,
    itemId: item._id,
    product: item.product || '',
    productCode: item.productCode || '',
    unit: stageUnit(item, row.stage),
    inputQty: Number(row.inputQty) || 0,
    outputQty: Number(row.outputQty) || 0,
    wasteQty: Number(row.wasteQty) || 0,
    shift: row.shift || '',
    workDate: row.workDate || row.completedAt || new Date(),
    notes: row.notes || '',
    machineName: row.machineName || '',
    pickedLotName: row.pickedLotName || '',
    vehicleNumber: row.vehicleNumber || '',
    handoverPerson: row.handoverPerson || '',
    deliveryPartner: row.deliveryPartner || '',
    details: publicDetails(row.details),
    markedBy: row.operator || null,
    markedByName: row.operatorName || '',
    markedAt: row.completedAt || new Date(),
  };
}

function toPublicEntry(row) {
  return {
    id: String(row._id),
    stage: row.stage,
    itemId: row.itemId ? String(row.itemId) : '',
    product: row.product || '',
    productCode: row.productCode || '',
    unit: row.unit || 'pcs',
    inputQty: row.inputQty || 0,
    outputQty: row.outputQty || 0,
    wasteQty: row.wasteQty || 0,
    shift: row.shift || '',
    workDate: row.workDate,
    notes: row.notes || '',
    machineName: row.machineName || '',
    pickedLotName: row.pickedLotName || '',
    vehicleNumber: row.vehicleNumber || '',
    handoverPerson: row.handoverPerson || '',
    deliveryPartner: row.deliveryPartner || '',
    details: publicDetails(row.details),
    markedByName: row.markedByName || '',
    markedAt: row.markedAt,
  };
}

function readableStages(user, order) {
  return stagesForOrder(order).filter((stage) => canReadBook(user, stage));
}

function stageLabel(stage) {
  return FLOOR_STAGES.find((item) => item.id === stage)?.label || stage;
}

function entryKey(itemId, row) {
  const at = new Date(row.completedAt || row.markedAt || row.workDate || 0).getTime();
  return [
    String(itemId || ''),
    row.stage || '',
    at,
    Number(row.inputQty) || 0,
    Number(row.outputQty) || 0,
    Number(row.wasteQty) || 0,
  ].join('|');
}

function entriesFromWork(order) {
  const entries = [];
  for (const item of order.items || []) {
    for (const row of item.stageWork || []) {
      if (!row?.stage) continue;
      entries.push(entryFromWork(item, row));
    }
  }
  return entries;
}

async function ensureRegister(order, preloaded) {
  const stages = stagesForOrder(order);
  const customerName = customerNameOf(order);
  let doc = preloaded === undefined ? await repo.findByOrderId(order._id) : preloaded;
  if (!doc) {
    try {
      return await repo.create({
        salesOrder: order._id,
        orderNumber: order.number,
        customerName,
        stages: stages.map((stage) => ({ stage })),
        entries: entriesFromWork(order),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      doc = await repo.findByOrderId(order._id);
      if (!doc) throw error;
    }
  }

  let dirty = false;
  if (doc.orderNumber !== order.number) {
    doc.orderNumber = order.number;
    dirty = true;
  }
  if (doc.customerName !== customerName) {
    doc.customerName = customerName;
    dirty = true;
  }
  const haveStages = new Set((doc.stages || []).map((row) => row.stage));
  for (const stage of stages) {
    if (!haveStages.has(stage)) {
      doc.stages.push({ stage });
      dirty = true;
    }
  }
  const haveEntries = new Set((doc.entries || []).map((row) => entryKey(row.itemId, row)));
  for (const entry of entriesFromWork(order)) {
    const key = entryKey(entry.itemId, entry);
    if (haveEntries.has(key)) continue;
    doc.entries.push(entry);
    haveEntries.add(key);
    dirty = true;
  }
  if (dirty) await repo.save(doc);
  return doc;
}

async function preloadRegisters(orders) {
  const docs = await repo.findByOrderIds(orders.map((order) => order._id));
  return new Map(docs.map((doc) => [String(doc.salesOrder), doc]));
}

async function openForOrder(order) {
  return ensureRegister(order);
}

async function recordMark(order, item, workRow) {
  if (!workRow?.stage) return null;
  const existing = await repo.findByOrderId(order._id);
  if (!existing) return ensureRegister(order);

  existing.orderNumber = order.number;
  existing.customerName = customerNameOf(order);
  const have = new Set((existing.stages || []).map((row) => row.stage));
  if (!have.has(workRow.stage)) existing.stages.push({ stage: workRow.stage });
  const next = entryFromWork(item, workRow);
  const key = entryKey(item._id, next);
  const haveEntries = new Set((existing.entries || []).map((row) => entryKey(row.itemId, row)));
  if (haveEntries.has(key)) return existing;
  existing.entries.push(next);
  return repo.save(existing);
}

function lineView(user, order, item, stage, doc) {
  const stats = stageStats(item, stage);
  const ready = itemVisibleAtStage(item, stage, order.status);
  const entries = (doc.entries || [])
    .filter((row) => row.stage === stage && String(row.itemId) === String(item._id))
    .map(toPublicEntry)
    .sort((a, b) => new Date(a.workDate || a.markedAt) - new Date(b.workDate || b.markedAt));
  return {
    itemId: String(item._id),
    product: item.product || '',
    productCode: item.productCode || '',
    quantity: stats.target,
    unit: stats.unit,
    output: stats.output,
    remaining: stats.remaining,
    done: stats.done,
    ready,
    canMark: ready && canWorkStage(user, stage),
    jobId: `${order._id}:${item._id}:${stage}`,
    specs: registerSpecs(order, item, stage),
    entries,
  };
}

function presentOrder(user, order, doc) {
  const stages = readableStages(user, order).map((stage) => {
    const lines = (order.items || [])
      .filter((item) => routeStages(item.productionRoute).includes(stage))
      .map((item) => lineView(user, order, item, stage, doc));
    const marked = lines.reduce((sum, line) => sum + line.entries.length, 0);
    return {
      id: stage,
      label: stageLabel(stage),
      marked,
      open: lines.some((line) => line.ready),
      lines,
    };
  });

  return {
    id: String(doc._id),
    orderId: String(order._id),
    orderNumber: order.number,
    customerName: customerNameOf(order),
    status: order.status,
    priority: order.priority,
    deliveryDate: order.deliveryDate,
    stages,
  };
}

async function list(user) {
  assertCanView(user);
  const orders = await salesOrderRepo.findAll({ status: { $in: REGISTER_STATUSES } });
  const docs = await preloadRegisters(orders);
  const rows = [];
  for (const order of orders) {
    const stages = readableStages(user, order);
    if (!stages.length) continue;
    const doc = await ensureRegister(order, docs.get(String(order._id)) || null);
    const summary = presentOrder(user, order, doc);
    rows.push({
      id: summary.id,
      orderId: summary.orderId,
      orderNumber: summary.orderNumber,
      customerName: summary.customerName,
      status: summary.status,
      priority: summary.priority,
      deliveryDate: summary.deliveryDate,
      stages: summary.stages.map((stage) => ({
        id: stage.id,
        label: stage.label,
        marked: stage.marked,
        open: stage.open,
        lines: stage.lines.length,
      })),
    });
  }
  return rows;
}

async function getByOrder(user, orderId) {
  assertCanView(user);
  const order = await salesOrderRepo.findById(orderId);
  if (!order) throw new ApiError(404, 'Sales order not found');
  if (!REGISTER_STATUSES.includes(order.status)) {
    throw new ApiError(400, 'This sales order has no register yet');
  }
  if (!readableStages(user, order).length) {
    throw new ApiError(403, 'You cannot view this register');
  }
  const doc = await ensureRegister(order);
  const book = presentOrder(user, order, doc);
  for (const stage of book.stages) {
    for (const line of stage.lines) {
      const item = (order.items || []).find((row) => String(row._id) === line.itemId);
      const inHand = item?.stagePickup?.stage === stage.id && Number(item.stagePickup.qty) > 0;
      const lots =
        line.ready && item
          ? await require('../production/production.service').sourceLots(order, item, stage.id)
          : [];
      const hasMaterial = inHand || lots.some((lot) => Number(lot.quantity) > 0);
      line.canEnter = Boolean(line.canMark && hasMaterial);
      line.blockedReason = line.canMark && !hasMaterial ? 'Nothing in store' : '';
    }
  }
  return book;
}

async function getStage(user, stage) {
  if (!FLOOR_STAGES.some((item) => item.id === stage)) {
    throw new ApiError(400, 'Unknown production stage');
  }
  if (!canReadBook(user, stage)) {
    throw new ApiError(403, 'You cannot view this stage register');
  }

  const orders = await salesOrderRepo.findAll({ status: { $in: REGISTER_STATUSES } });
  const docs = await preloadRegisters(orders);
  const open = [];
  const entries = [];
  for (const order of orders) {
    if (!stagesForOrder(order).includes(stage)) continue;
    const doc = await ensureRegister(order, docs.get(String(order._id)) || null);
    for (const item of order.items || []) {
      if (!routeStages(item.productionRoute).includes(stage)) continue;
      const line = lineView(user, order, item, stage, doc);
      const sourceLots = line.ready
        ? await require('../production/production.service').sourceLots(order, item, stage)
        : [];
      const inHand = item.stagePickup?.stage === stage && Number(item.stagePickup.qty) > 0;
      const hasMaterial = inHand || sourceLots.some((lot) => Number(lot.quantity) > 0);
      if (line.ready && hasMaterial) {
        open.push({
          orderId: String(order._id),
          orderNumber: order.number,
          customerName: customerNameOf(order),
          priority: order.priority,
          deliveryDate: order.deliveryDate,
          sourceLots,
          ...line,
          pickup: inHand
            ? {
                qty: Number(item.stagePickup.qty) || 0,
                unit: item.stagePickup.unit || line.unit || '',
                lotName: item.stagePickup.lotName || '',
              }
            : null,
        });
      }
      for (const entry of line.entries) {
        entries.push({
          ...entry,
          orderId: String(order._id),
          orderNumber: order.number,
          customerName: customerNameOf(order),
        });
      }
    }
  }

  entries.sort((a, b) => new Date(b.markedAt || b.workDate) - new Date(a.markedAt || a.workDate));
  return {
    stage,
    label: stageLabel(stage),
    canMark: canWorkStage(user, stage),
    open,
    entries,
  };
}

module.exports = {
  openForOrder,
  recordMark,
  list,
  getByOrder,
  getStage,
};
