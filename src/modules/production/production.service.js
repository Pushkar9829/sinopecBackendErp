const { INVENTORY_CATEGORIES, DELIVERY_PARTNERS, SALES_ORDER_STATUSES } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { hasPermission, isSuperAdmin } = require('../../utils/permissions');
const { businessYmd, endOfBusinessDay } = require('../../utils/businessTime');
const { afterCommit, inTransaction } = require('../../utils/transaction');
const itemRepo = require('../inventory/item.repo');
const stageRepo = require('../inventory/stage.repo');
const machineRepo = require('../machine/machine.repo');
const salesOrderRepo = require('../salesOrder/salesOrder.repo');
const {
  FLOOR_STAGES,
  FLOOR_ORDER_STATUSES,
  activeStage,
  availableFromPrevious,
  canReadStage,
  canWorkStage,
  closedStages,
  isDeliveryStage,
  isStageClosed,
  itemVisibleAtStage,
  previousStage,
  registerSpecs,
  routeStages,
  stageRequirements,
  stageStats,
  stageTarget,
  stageUnit,
  syncOrderStatus,
  takesNoStock,
  visibleStages,
  wasteUnitOf,
} = require('./production.flow');

function sameUnit(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}


// Floor work moves an order up to Delivered at most; Completed is set by the
// "mark completed" action (advanceOrder), which also stamps completedAt.
// Once an order is Delivered nothing can be released from the floor, so any
// material still held at a stage is detached here and must be handed to
// returnSettledPickups after the order is saved (same transaction).
function applyOrderStatus(order) {
  order.status = syncOrderStatus(order);
  return order.status === SALES_ORDER_STATUSES.DELIVERED ? detachOrderPickups(order) : [];
}

async function returnSettledPickups(order, detached) {
  for (const { item, held } of detached || []) {
    try {
      await restockHeld(order, item, held);
    } catch (error) {
      console.error(
        `STOCK NOT RETURNED on delivery of ${order.number}: ${held.qty} ${held.unit} from lot ${held.lot} (${held.lotName}). Fix inventory by hand.`,
        error.message
      );
      throw new ApiError(500, 'Material held on the floor could not be put back in store. Tell the store manager.');
    }
  }
}

// Work cannot be dated after today (plant time).
function parseWorkDate(value, fallback) {
  if (!value) return fallback === undefined ? new Date() : fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, 'Work date is not valid');
  if (date.getTime() > endOfBusinessDay(new Date()).getTime()) {
    throw new ApiError(400, 'Work date cannot be in the future');
  }
  return date;
}

function isProductionManager(user) {
  return isSuperAdmin(user) || hasPermission(user, 'production:update');
}

// wasteUnit is not declared on the order's stageWork schema yet, so it is set
// with strict: false (a plain assignment would be dropped).
function setWasteUnit(row, unit) {
  if (!row || typeof row.set !== 'function') return;
  row.set('wasteUnit', unit || '', { strict: false });
}

// Task sync and register marks run after the floor action's transaction
// commits (see utils/transaction.js).
function syncTasks(order, user, options) {
  return afterCommit(() => require('../task/task.hooks').syncOrder(order, user, options));
}

function num(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const TYPED_DETAIL_KEYS = [
  'rollType',
  'gross',
  'tare',
  'net',
  'description',
  'cylinderSize',
  'printDescription',
  'wastage',
  'tubeUsed',
  'packets',
];

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

const LONG_DETAIL_KEYS = new Set(['description', 'printDescription']);

function detailLimit(key) {
  return LONG_DETAIL_KEYS.has(key) ? 1000 : 200;
}

function buildDetails(order, item, stage, raw) {
  const specs = registerSpecs(order, item, stage);
  const typed = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of TYPED_DETAIL_KEYS) {
      if (raw[key] == null || raw[key] === '') continue;
      typed[key] = String(raw[key]).trim().slice(0, detailLimit(key));
    }
  }
  const details = {};
  for (const [key, value] of Object.entries({ ...specs, ...typed })) {
    if (value == null || String(value).trim() === '') continue;
    details[key] = String(value).trim().slice(0, detailLimit(key));
  }
  if (stage === 'rolling' && typed.net !== undefined && typed.gross !== undefined) {
    const gross = Number(typed.gross);
    const net = Number(typed.net);
    if (Number.isFinite(gross) && Number.isFinite(net) && gross > 0 && net > gross) {
      throw new ApiError(400, 'Net weight cannot be more than gross weight');
    }
  }
  if (stage === 'rolling' && typed.net === undefined && typed.gross !== undefined) {
    const gross = Number(typed.gross);
    const tare = Number(typed.tare) || 0;
    if (Number.isFinite(gross) && tare > gross) throw new ApiError(400, 'Tare cannot be more than gross weight');
    if (Number.isFinite(gross)) details.net = String(Math.round((gross - tare) * 1000) / 1000);
  }
  return details;
}

function toPublicWork(row, item) {
  return {
    stage: row.stage,
    machineId: row.machine ? String(row.machine) : '',
    machineName: row.machineName || '',
    operatorName: row.operatorName || '',
    inputQty: row.inputQty || 0,
    outputQty: row.outputQty || 0,
    wasteQty: row.wasteQty || 0,
    wasteUnit: row.wasteQty && item ? wasteUnitOf(item, row) : '',
    workDate: row.workDate || row.completedAt,
    notes: row.notes || '',
    fromStage: row.fromStage || '',
    pickedLotName: row.pickedLotName || '',
    vehicleNumber: row.vehicleNumber || '',
    handoverPerson: row.handoverPerson || '',
    deliveryPartner: row.deliveryPartner || '',
    details: publicDetails(row.details),
    completedAt: row.completedAt,
  };
}

function stageTitle(stage) {
  if (!stage) return 'Store';
  return FLOOR_STAGES.find((item) => item.id === stage)?.label || stage;
}

// Company raw material (not WIP, not a customer's own material) may run into
// negative stock: the floor is never stopped because the store is behind.
function canGoNegative(lot) {
  return Boolean(lot) && lot.category === INVENTORY_CATEGORIES.RAW && lot.kind !== 'wip' && !lot.salesOrder;
}

function toPublicLot(lot, fromStage) {
  if (!lot) return null;
  return {
    id: String(lot._id),
    name: lot.name,
    quantity: Number(lot.quantity) || 0,
    unit: lot.unit || 'pcs',
    stage: lot.wipStage || fromStage || '',
    kind: lot.kind || 'catalog',
    category: lot.category,
    notes: lot.notes || '',
    canGoNegative: canGoNegative(lot),
  };
}

function toPublicPickup(item, stage) {
  const pickup = item.stagePickup;
  if (!pickup || pickup.stage !== stage || !(Number(pickup.qty) > 0)) return null;
  return {
    lotId: pickup.lot ? String(pickup.lot) : '',
    lotName: pickup.lotName || '',
    fromStage: pickup.fromStage || '',
    fromStageLabel: stageTitle(pickup.fromStage),
    qty: Number(pickup.qty) || 0,
    unit: pickup.unit || item.unit || 'pcs',
    pickedByName: pickup.pickedByName || '',
    pickedAt: pickup.pickedAt || null,
  };
}

function clearPickup(item) {
  item.stagePickup = {
    stage: '',
    fromStage: '',
    lot: null,
    lotName: '',
    qty: 0,
    unit: '',
    pickedBy: null,
    pickedByName: '',
    pickedAt: null,
  };
}

// Per-request cache so list screens load raw stock once and WIP lots once per
// order, instead of one query per line item.
function createLotCache() {
  return { raw: null, wip: new Map() };
}

function loadRawLots(cache) {
  const query = () =>
    itemRepo.findAll({
      category: INVENTORY_CATEGORIES.RAW,
      isActive: true,
      kind: { $ne: 'wip' },
    });
  if (!cache) return query();
  // Cache the settled promise, not the Mongoose Query: a Query can only run once.
  cache.raw = cache.raw || Promise.resolve().then(query);
  return cache.raw;
}

function loadOrderWipLots(cache, orderId) {
  const query = () =>
    itemRepo.findAll({
      salesOrder: orderId,
      category: INVENTORY_CATEGORIES.OUTPUT,
      kind: 'wip',
    });
  if (!cache) return query();
  const key = String(orderId);
  if (!cache.wip.has(key)) cache.wip.set(key, Promise.resolve().then(query));
  return cache.wip.get(key);
}

async function listSourceLots(order, item, stage, cache = null) {
  if (takesNoStock(item.productionRoute, stage)) return [];
  const prev = previousStage(item.productionRoute, stage);
  if (!prev) {
    const rawName = String(item.manufacturing?.rawMaterial || item.material || '').toLowerCase();
    const rawItems = await loadRawLots(cache);
    const ownLot = (row) => Boolean(row.salesOrder) && String(row.salesOrder?._id || row.salesOrder) === String(order._id);
    const own = rawItems.filter((row) => ownLot(row) && Number(row.quantity) > 0);
    const company = rawItems.filter((row) => !row.salesOrder);
    const words = rawName.split(/[^a-z0-9]+/).filter((word) => word.length > 1 && word !== 'granules');
    const matches = (row) => {
      const hay = `${row.name || ''} ${row.materialType || ''}`.toLowerCase();
      if (hay.includes(rawName)) return true;
      return words.length > 0 && words.every((word) => hay.includes(word));
    };
    // A line with no raw material named is offered only its own (customer) lots.
    // Matching company stock is offered even at zero or below; when nothing
    // matches the name, any company raw material can be picked.
    let shared = rawName ? company.filter(matches) : [];
    if (rawName && !shared.length) shared = company;
    shared = [...shared].sort((a, b) => (Number(b.quantity) || 0) - (Number(a.quantity) || 0));
    return [...own, ...shared].map((lot) => toPublicLot(lot, ''));
  }

  const lots = (await loadOrderWipLots(cache, order._id)).filter(
    (lot) => String(lot.lineItem) === String(item._id) && lot.wipStage === prev
  );
  return lots.filter((lot) => Number(lot.quantity) > 0).map((lot) => toPublicLot(lot, prev));
}

async function toJob(order, item, stage, cache = null) {
  const stats = stageStats(item, stage);
  const availableInput = availableFromPrevious(item, stage);
  const prev = previousStage(item.productionRoute, stage);
  const sourceLots = await listSourceLots(order, item, stage, cache);
  const pickup = toPublicPickup(item, stage);
  const readyQty = sourceLots.reduce((sum, lot) => sum + (Number(lot.quantity) || 0), 0);
  return {
    id: `${order._id}:${item._id}:${stage}`,
    orderId: String(order._id),
    itemId: String(item._id),
    stage,
    number: order.number,
    orderType: order.orderType || 'sales_order',
    priority: order.priority,
    deliveryDate: order.deliveryDate,
    customerCode: order.customerSnapshot?.code || order.customer?.code || '',
    product: item.product || '',
    productCode: item.productCode || '',
    quantity: stats.target,
    unit: stats.unit,
    productionRoute: item.productionRoute,
    routeStages: routeStages(item.productionRoute),
    currentStage: activeStage(item),
    nextStage: stats.done ? 'completed' : stage,
    previousStage: prev,
    previousStageLabel: stageTitle(prev),
    progress: stats,
    availableInput,
    readyQty,
    pickup,
    noStock: takesNoStock(item.productionRoute, stage),
    otherProcess: item.otherProcess || '',
    sourceLots,
    requirements: stageRequirements(order, item, stage),
    history: (item.stageWork || []).filter((row) => row.stage === stage).map((row) => toPublicWork(row, item)),
  };
}

async function listQueue(user, stage) {
  const allowed = visibleStages(user);
  if (!allowed.length) {
    throw new ApiError(403, 'You cannot view the production floor');
  }

  const requested = stage || allowed[0].id;
  if (!FLOOR_STAGES.some((item) => item.id === requested)) {
    throw new ApiError(400, 'Unknown production stage');
  }
  if (!canReadStage(user, requested)) {
    throw new ApiError(403, 'You cannot view this stage');
  }

  const orders = await salesOrderRepo.findAllForFloor({ status: { $in: FLOOR_ORDER_STATUSES } }, { lean: true });

  const jobs = [];
  const counts = Object.fromEntries(FLOOR_STAGES.map((item) => [item.id, 0]));
  const lotCache = createLotCache();
  for (const order of orders) {
    for (const item of order.items || []) {
      if (itemVisibleAtStage(item, requested, order.status)) {
        const job = await toJob(order, item, requested, lotCache);
        if ((job.readyQty > 0) || job.pickup || job.noStock) jobs.push(job);
      }
      for (const floor of FLOOR_STAGES) {
        if (canReadStage(user, floor.id) && itemVisibleAtStage(item, floor.id, order.status)) {
          counts[floor.id] += 1;
        }
      }
    }
  }
  counts[requested] = jobs.length;

  return {
    stage: requested,
    stages: allowed.map((item) => ({ ...item, count: counts[item.id] || 0 })),
    deliveryPartners: DELIVERY_PARTNERS,
    jobs,
  };
}

async function loadFloorItem(user, payload, { mustWork }) {
  const stage = String(payload.stage || '').trim();
  if (!FLOOR_STAGES.some((item) => item.id === stage)) {
    throw new ApiError(400, 'Unknown production stage');
  }
  if (mustWork && !canWorkStage(user, stage)) {
    throw new ApiError(403, 'You cannot record work on this stage');
  }
  if (!mustWork && !canReadStage(user, stage)) {
    throw new ApiError(403, 'You cannot view this stage');
  }

  const order = await salesOrderRepo.findById(payload.orderId);
  if (!order) throw new ApiError(404, 'Order not found');
  if (!FLOOR_ORDER_STATUSES.includes(order.status)) {
    throw new ApiError(400, 'This order is not on the production floor');
  }

  const item = (order.items || []).id(payload.itemId);
  if (!item) throw new ApiError(404, 'Line item not found');
  if (!routeStages(item.productionRoute).includes(stage)) {
    throw new ApiError(400, 'This product does not go through that stage');
  }
  return { order, item, stage };
}

async function createEntryLot({ order, item, stage, category, qty, unit, workDate }) {
  if (!stage || isDeliveryStage(stage) || qty <= 0) return null;
  const stageDoc = await stageRepo.findBySlug(stage);

  const suffix = category === INVENTORY_CATEGORIES.WASTE ? 'waste' : 'output';
  const when = workDate ? new Date(workDate) : new Date();
  const dateLabel = businessYmd(when);
  const name = `${order.number} · ${item.productCode || item.product || 'item'} · ${stage} ${suffix}${dateLabel ? ` · ${dateLabel}` : ''}`;

  return itemRepo.create({
    category,
    name,
    materialType: item.material || item.manufacturing?.materialType || 'WIP',
    unit: unit || item.unit || 'pcs',
    quantity: qty,
    unitPrice: category === INVENTORY_CATEGORIES.WASTE ? null : 0,
    stage: stageDoc?._id || null,
    notes: `From order ${order.number}`,
    isActive: true,
    kind: 'wip',
    wipStage: stage,
    salesOrder: order._id,
    lineItem: item._id,
  });
}

// Quantities in messages: floating-point sums like 23.755999999999997 show
// as 23.756 (at most 3 decimals, no trailing zeros).
function qtyText(value) {
  return String(Math.round((Number(value) || 0) * 1000) / 1000);
}

function logUndoFailure(error) {
  console.error('INVENTORY UNDO FAILED after an order save error; stock may be off. Check the lot by hand.', error?.message || error);
}

async function takeFromLot(lot, qty) {
  if (!lot) throw new ApiError(400, 'That inventory lot was not found');
  const updated = await itemRepo.takeQuantity(lot._id, qty, { allowNegative: canGoNegative(lot) });
  if (!updated) {
    const fresh = await itemRepo.findById(lot._id);
    throw new ApiError(400, `Only ${qtyText(fresh?.quantity)} is left on ${lot.name || 'that lot'}.`);
  }
  lot.quantity = updated.quantity;
}

async function returnToLot(lotId, qty, unit, fallback) {
  if (!lotId || qty <= 0) return;
  const lot = await itemRepo.addQuantity(lotId, qty);
  if (lot) return;
  if (fallback) await fallback(qty, unit);
}

// Puts held stock back into store. If the original lot was deleted meanwhile,
// a replacement lot is created so the quantity is never lost.
async function restockHeld(order, item, held) {
  await returnToLot(held.lot, held.qty, held.unit, async (qty, unit) => {
    const fromStage = held.fromStage;
    await itemRepo.create({
      category: fromStage ? INVENTORY_CATEGORIES.OUTPUT : INVENTORY_CATEGORIES.RAW,
      name: held.lotName || `${order.number} returned`,
      materialType: item.material || item.manufacturing?.materialType || 'WIP',
      unit: unit || item.unit || 'pcs',
      quantity: qty,
      unitPrice: fromStage ? 0 : null,
      notes: `Returned to store from ${order.number}`,
      isActive: true,
      kind: fromStage ? 'wip' : 'catalog',
      wipStage: fromStage,
      salesOrder: fromStage ? order._id : null,
      lineItem: fromStage ? item._id : null,
    });
  });
}

function heldFrom(pickup) {
  return {
    lot: pickup.lot,
    qty: Number(pickup.qty),
    unit: pickup.unit,
    fromStage: pickup.fromStage || '',
    lotName: pickup.lotName || '',
  };
}

// Step 1 of cancelling: clears every pickup on the in-memory order and returns
// what was held. Nothing touches inventory until the cancelled order is saved
// (a version-checked save), so a lost race can't return stock twice.
function detachOrderPickups(order) {
  const detached = [];
  for (const item of order.items || []) {
    const pickup = item.stagePickup;
    if (pickup && Number(pickup.qty) > 0) {
      detached.push({ item, held: heldFrom(pickup) });
      clearPickup(item);
    }
  }
  return detached;
}

// Step 2, after the cancelled status is saved.
async function releaseOrderStock(order, detached) {
  for (const { item, held } of detached) {
    try {
      await restockHeld(order, item, held);
    } catch (error) {
      console.error(
        `STOCK NOT RETURNED on cancel of ${order.number}: ${held.qty} ${held.unit} from lot ${held.lot} (${held.lotName}). Fix inventory by hand.`,
        error.message
      );
    }
  }
  await itemRepo.retireOrderLots(order._id, `order ${order.number} cancelled`);
}

async function pickupLot(user, payload) {
  const { order, item, stage } = await loadFloorItem(user, payload, { mustWork: true });
  const qty = num(payload.qty);
  if (qty <= 0) throw new ApiError(400, 'Enter how much to pick');
  if (takesNoStock(item.productionRoute, stage)) {
    throw new ApiError(400, 'This step takes nothing from stock. Enter the work directly.');
  }

  const prev = previousStage(item.productionRoute, stage);
  const lot = await itemRepo.findById(payload.lotId);
  if (!lot || lot.isActive === false) throw new ApiError(400, 'That inventory lot was not found');

  if (!prev) {
    if (lot.category !== INVENTORY_CATEGORIES.RAW || lot.kind === 'wip') {
      throw new ApiError(400, 'Pick raw material from the store');
    }
    if (lot.salesOrder && String(lot.salesOrder?._id || lot.salesOrder) !== String(order._id)) {
      throw new ApiError(400, 'That lot is customer material for another job work');
    }
    // Same list the operator was offered: matching material, in stock.
    const offered = await listSourceLots(order, item, stage);
    if (!offered.some((row) => String(row.id) === String(lot._id))) {
      throw new ApiError(400, `${lot.name || 'That lot'} is not material for this product`);
    }
  } else {
    const matches =
      lot.kind === 'wip' &&
      lot.category === INVENTORY_CATEGORIES.OUTPUT &&
      String(lot.salesOrder) === String(order._id) &&
      String(lot.lineItem) === String(item._id) &&
      lot.wipStage === prev;
    if (!matches) {
      throw new ApiError(400, `Pick ${stageTitle(prev)} output for this order`);
    }
  }

  if (isDeliveryStage(stage)) {
    return sendDelivery(user, { order, item, stage, lot, qty, prev, payload });
  }

  const current = item.stagePickup || {};
  if (Number(current.qty) > 0 && current.stage === stage && current.lot && String(current.lot) !== String(lot._id)) {
    throw new ApiError(400, 'Finish or return the lot already marked for working before picking another');
  }

  await takeFromLot(lot, qty);
  const already = current.stage === stage && String(current.lot || '') === String(lot._id) ? Number(current.qty) || 0 : 0;
  item.stagePickup = {
    stage,
    fromStage: prev || '',
    lot: lot._id,
    lotName: lot.name,
    qty: already + qty,
    unit: lot.unit || item.unit || 'pcs',
    pickedBy: user._id,
    pickedByName: user.fullName || user.username || '',
    pickedAt: new Date(),
  };
  item.currentStage = stage;
  const settled = applyOrderStatus(order);
  try {
    await salesOrderRepo.save(order);
  } catch (error) {
    await itemRepo.addQuantity(lot._id, qty).catch(logUndoFailure);
    throw error;
  }
  await returnSettledPickups(order, settled);
  await syncTasks(order, user);
  return toJob(order, item, stage);
}

// Dispatching pieces from a kg lot: the kg typed in must roughly match what
// the order says those pieces weigh (required weight / ordered quantity).
// Floor variation is normal, so only clearly wrong figures are stopped, and a
// production manager can still record an unusual dispatch.
const DISPATCH_WEIGHT_TOLERANCE = { min: 0.5, max: 2 };

function assertPlausibleDispatch(user, item, lot, qty, used, unit) {
  if (isSuperAdmin(user) || hasPermission(user, 'production:update')) return;
  if (String(lot.unit || '').toLowerCase() !== 'kg') return;
  const orderedKg = stageTarget(item, 'rolling');
  const orderedQty = Number(item.quantity) || 0;
  if (!(orderedKg > 0) || !(orderedQty > 0)) return;
  const expected = (orderedKg / orderedQty) * qty;
  if (used < expected * DISPATCH_WEIGHT_TOLERANCE.min || used > expected * DISPATCH_WEIGHT_TOLERANCE.max) {
    const shown = Math.round(expected * 100) / 100;
    throw new ApiError(
      400,
      `${qty} ${unit} should weigh about ${shown} kg on this order, not ${used} kg. Check the figures, or ask a production manager to record it.`
    );
  }
}

async function sendDelivery(user, { order, item, stage, lot, qty, prev, payload }) {
  const vehicleNumber = String(payload.vehicleNumber || '').trim();
  const handoverPerson = String(payload.handoverPerson || '').trim();
  const deliveryPartner = String(payload.deliveryPartner || '').trim();
  if (!DELIVERY_PARTNERS.includes(deliveryPartner)) {
    throw new ApiError(400, 'Select In-house, Delhivery, or Customer');
  }
  if (!handoverPerson) throw new ApiError(400, 'Enter the person taking these goods');
  if (!vehicleNumber) throw new ApiError(400, 'Enter the vehicle number');

  const stats = stageStats(item, stage);
  if (qty - stats.remaining > 1e-6) {
    throw new ApiError(400, `Only ${qtyText(stats.remaining)} left to dispatch`);
  }

  const workDate = parseWorkDate(payload.workDate);

  // Direct dispatch (no lot): the quantity sent is recorded, no stock moves.
  const unitsDiffer = Boolean(lot) && !sameUnit(lot.unit, stats.unit);
  const used = !lot ? 0 : unitsDiffer ? num(payload.inputQty) : qty;
  if (unitsDiffer && !(used > 0)) {
    throw new ApiError(400, `Enter how much ${lot.unit} is going out with these ${qty} ${stats.unit}`);
  }
  if (unitsDiffer) assertPlausibleDispatch(user, item, lot, qty, used, stats.unit);
  if (lot) await takeFromLot(lot, used);
  const undo = () => (lot ? itemRepo.addQuantity(lot._id, used).catch(logUndoFailure) : null);
  const workRow = {
    stage,
    machine: null,
    machineName: '',
    operator: user._id,
    operatorName: user.fullName || user.username || '',
    inputQty: used,
    outputQty: qty,
    wasteQty: 0,
    workDate,
    notes: String(payload.notes || '').trim(),
    fromStage: prev || '',
    pickedLotName: lot?.name || '',
    vehicleNumber,
    handoverPerson,
    deliveryPartner,
    details: buildDetails(order, item, stage, payload.details),
    sourceLot: lot?._id || null,
    completedAt: new Date(),
  };
  item.stageWork = item.stageWork || [];
  item.stageWork.push(workRow);
  const savedRow = item.stageWork[item.stageWork.length - 1];
  item.currentStage = activeStage(item);
  const settled = applyOrderStatus(order);
  try {
    await salesOrderRepo.save(order);
  } catch (error) {
    await undo();
    throw error;
  }
  await returnSettledPickups(order, settled);
  await markRegister(order, item, savedRow);
  await syncTasks(order, user);
  return toJob(order, item, stage);
}

function markRegister(order, item, workRow) {
  return afterCommit(() => recordRegisterMark(order, item, workRow));
}

async function recordRegisterMark(order, item, workRow) {
  try {
    await require('../register/register.service').recordMark(order, item, workRow);
  } catch (error) {
    console.error('Register mark failed; it is rebuilt from the order on next open', error.message);
  }
}

async function releasePickup(user, payload) {
  const { order, item, stage } = await loadFloorItem(user, payload, { mustWork: true });
  const pickup = item.stagePickup;
  if (!pickup || pickup.stage !== stage || !(Number(pickup.qty) > 0)) {
    throw new ApiError(400, 'Nothing is marked for working');
  }
  if (pickup.pickedBy && String(pickup.pickedBy) !== String(user._id) && !isProductionManager(user)) {
    throw new ApiError(403, `${pickup.pickedByName || 'Another operator'} holds this lot. Only they or a production manager can return it.`);
  }
  const held = heldFrom(pickup);
  const releasedBy = pickup.pickedBy ? String(pickup.pickedBy) : '';
  clearPickup(item);
  // Save first (version-checked): if another request changed this order, we
  // fail here with nothing moved. Once saved, the stock must go back.
  await salesOrderRepo.save(order);
  try {
    await restockHeld(order, item, held);
  } catch (error) {
    console.error(
      `STOCK NOT RETURNED on release for ${order.number}: ${held.qty} ${held.unit} from lot ${held.lot} (${held.lotName}). Fix inventory by hand.`,
      error.message
    );
    throw new ApiError(500, 'The lot was released but its stock could not be put back. Tell the store manager.');
  }
  await syncTasks(order, user, { released: { itemId: String(item._id), stage, by: releasedBy } });
  return toJob(order, item, stage);
}

async function completeStage(user, payload) {
  const { order, item, stage } = await loadFloorItem(user, payload, { mustWork: true });
  if (isDeliveryStage(stage)) {
    throw new ApiError(400, 'Record dispatches with Enter on the Dispatch register');
  }
  if (!itemVisibleAtStage(item, stage, order.status) && !stageStats(item, stage).output && !(Number(item.stagePickup?.qty) > 0)) {
    throw new ApiError(400, `Nothing is ready for ${stage} yet`);
  }

  const stats = stageStats(item, stage);
  const inputQty = num(payload.inputQty);
  const outputQty = num(payload.outputQty);
  const wasteQty = num(payload.wasteQty);
  // Dispatch never reaches here (it is recorded through pickupLot/sendDelivery).
  const produced = outputQty;
  if (inputQty < 0 || outputQty < 0 || wasteQty < 0) {
    throw new ApiError(400, 'Quantities cannot be negative');
  }
  if (produced <= 0) {
    throw new ApiError(400, 'Enter how much this entry produced');
  }
  if (stats.capped && produced - stats.remaining > 1e-6) {
    throw new ApiError(400, `Only ${qtyText(stats.remaining)} ${stats.unit} left on this stage`);
  }

  // The "other" process takes no lot: what it used is only noted (any unit).
  const noStock = takesNoStock(item.productionRoute, stage);
  const pickup = noStock ? null : toPublicPickup(item, stage);
  if (!pickup && !noStock) {
    const prev = previousStage(item.productionRoute, stage);
    throw new ApiError(
      400,
      prev ? `Pick ${stageTitle(prev)} output and mark it for working first` : 'Pick raw material and mark it for working first'
    );
  }
  if (!noStock) {
    if (sameUnit(pickup.unit, stats.unit)) {
      if (outputQty + wasteQty - inputQty > 1e-6) {
        throw new ApiError(400, 'Made plus waste cannot be more than what was used');
      }
      if (inputQty - (outputQty + wasteQty) > 1e-6) {
        throw new ApiError(400, 'Used cannot be more than made plus waste');
      }
    }
    if (inputQty <= 0) {
      throw new ApiError(400, 'Enter how much of the picked lot this entry used');
    }
    if (inputQty - pickup.qty > 1e-6) {
      throw new ApiError(400, `Only ${qtyText(pickup.qty)} is marked for working from ${pickup.lotName}`);
    }
  }

  // Vehicle / handover fields only apply to dispatch rows, which are not made here.
  const vehicleNumber = '';
  const handoverPerson = '';
  const deliveryPartner = '';

  const workDate = parseWorkDate(payload.workDate);

  let machine = null;
  if (payload.machineId) {
    const stageDoc = await stageRepo.findBySlug(stage);
    machine = (stageDoc?.machines || []).find((row) => String(row._id) === String(payload.machineId)) || null;
    if (!machine) throw new ApiError(400, 'That machine is not assigned to this stage');
    if (machine.isActive === false) throw new ApiError(400, 'That machine is inactive');
  }
  // Validate the typed details before any lot is created (a standalone mongod
  // has no transaction to roll back a lot made before a 400).
  const details = buildDetails(order, item, stage, payload.details);
  // Waste is in the unit of what was used (kg of film at printing).
  const wasteUnit = pickup?.unit || stats.unit;

  const sourceLotId = noStock ? null : item.stagePickup.lot || null;
  if (!noStock) {
    const leftover = Math.max(0, Number(item.stagePickup.qty) - inputQty);
    if (leftover > 1e-9) {
      item.stagePickup.qty = leftover;
    } else {
      clearPickup(item);
    }
  }

  const createdLots = [];
  let savedRow;
  let settled;
  try {
    const outputLot = await createEntryLot({
      order,
      item,
      stage,
      category: INVENTORY_CATEGORIES.OUTPUT,
      qty: produced,
      unit: stats.unit,
      workDate,
    });
    if (outputLot) createdLots.push(outputLot);
    const wasteLot = await createEntryLot({
      order,
      item,
      stage,
      category: INVENTORY_CATEGORIES.WASTE,
      qty: wasteQty,
      unit: wasteUnit,
      workDate,
    });
    if (wasteLot) createdLots.push(wasteLot);

    const workRow = {
      stage,
      machine: machine?._id || null,
      machineName: machine ? `${machine.name}${machine.code ? ` (${machine.code})` : ''}` : '',
      operator: user._id,
      operatorName: user.fullName || user.username || '',
      inputQty,
      outputQty: produced,
      wasteQty,
      workDate,
      notes: String(payload.notes || '').trim(),
      fromStage: pickup?.fromStage || '',
      pickedLotName: pickup?.lotName || '',
      vehicleNumber,
      handoverPerson,
      deliveryPartner,
      details,
      sourceLot: sourceLotId,
      outputLot: outputLot?._id || null,
      wasteLot: wasteLot?._id || null,
      completedAt: new Date(),
    };
    if (wasteQty && !workRow.details.wastage) {
      workRow.details.wastage = String(wasteQty);
    }
    item.stageWork = item.stageWork || [];
    item.stageWork.push(workRow);
    savedRow = item.stageWork[item.stageWork.length - 1];
    if (wasteQty > 0) setWasteUnit(savedRow, wasteUnit);
    item.currentStage = activeStage(item);

    settled = applyOrderStatus(order);
    await salesOrderRepo.save(order);
  } catch (error) {
    // Nothing was saved: lots made for this entry must not stay behind.
    for (const lot of createdLots) await itemRepo.deleteById(lot._id).catch(() => {});
    throw error;
  }
  await returnSettledPickups(order, settled);
  await markRegister(order, item, savedRow);
  await syncTasks(order, user);
  return require('../salesOrder/salesOrder.service').getOrder(user, order._id);
}

function chooseLot(lots, payload, needed) {
  const wanted = String(payload.lotId || '');
  const match = wanted
    ? lots.find((lot) => lot.id === wanted)
    : lots.find((lot) => Number(lot.quantity) + 1e-9 >= needed) || lots.find((lot) => lot.canGoNegative);
  if (wanted && !match) {
    throw new ApiError(400, 'That material is not available for this entry');
  }
  if (!match) {
    const onHand = lots.reduce((sum, lot) => sum + (Number(lot.quantity) || 0), 0);
    throw new ApiError(
      400,
      onHand > 0 ? `Only ${qtyText(onHand)} is in store. Enter that much or less.` : 'Nothing is in store for this entry'
    );
  }
  if (!match.canGoNegative && Number(match.quantity) + 1e-9 < needed) {
    throw new ApiError(400, `Only ${qtyText(match.quantity)} is left on ${match.name}`);
  }
  return match;
}

async function enterFromRegister(user, payload) {
  const loaded = await loadFloorItem(user, payload, { mustWork: true });
  const { order, item, stage } = loaded;
  const outputQty = num(payload.outputQty);
  const bookWaste = payload.details && payload.details.wastage;
  const wasteQty = isDeliveryStage(stage)
    ? 0
    : payload.wasteQty === undefined || payload.wasteQty === null || payload.wasteQty === ''
      ? num(bookWaste)
      : num(payload.wasteQty);
  const givenInput = !(payload.inputQty === undefined || payload.inputQty === null || payload.inputQty === '');
  if (!isDeliveryStage(stage)) {
    const wastageText = bookWaste == null ? '' : String(bookWaste).trim();
    if (wastageText !== '' && !Number.isFinite(Number(wastageText))) {
      throw new ApiError(400, 'Enter wastage as a number');
    }
  }
  if (outputQty <= 0) throw new ApiError(400, 'Enter the production quantity');

  const stats = stageStats(item, stage);
  if (stats.capped && outputQty - stats.remaining > 1e-6) {
    throw new ApiError(400, `Only ${qtyText(stats.remaining)} ${stats.unit} left on this stage`);
  }

  const noStock = takesNoStock(item.productionRoute, stage);
  if (isDeliveryStage(stage) && noStock) {
    return sendDelivery(user, { order, item, stage, lot: null, qty: outputQty, prev: null, payload });
  }
  if (noStock) {
    if (givenInput && num(payload.inputQty) < 0) throw new ApiError(400, 'Quantities cannot be negative');
    return completeStage(user, {
      orderId: String(order._id),
      itemId: String(item._id),
      stage,
      machineId: payload.machineId,
      inputQty: givenInput ? num(payload.inputQty) : 0,
      outputQty,
      wasteQty,
      workDate: payload.workDate,
      notes: payload.notes,
      details: payload.details,
    });
  }

  if (isDeliveryStage(stage)) {
    const lots = await listSourceLots(order, item, stage);
    const preferred = lots.find((lot) => lot.id === String(payload.lotId || '')) || lots[0];
    const needed = preferred && !sameUnit(preferred.unit, stats.unit) ? num(payload.inputQty) : outputQty;
    const match = chooseLot(lots, payload, needed);
    const lot = await itemRepo.findById(match.id);
    const prev = previousStage(item.productionRoute, stage);
    return sendDelivery(user, { order, item, stage, lot, qty: outputQty, prev, payload });
  }

  const pickup = toPublicPickup(item, stage);
  const lots = pickup ? [] : await listSourceLots(order, item, stage);
  const wantedLot = pickup ? null : lots.find((lot) => lot.id === String(payload.lotId || '')) || lots[0] || null;
  const sourceUnit = pickup ? pickup.unit : wantedLot?.unit || stats.unit;
  const matching = sameUnit(sourceUnit, stats.unit);
  if (!givenInput && !matching) {
    throw new ApiError(400, `Enter how much ${sourceUnit} was used`);
  }
  const inputQty = givenInput ? num(payload.inputQty) : outputQty + wasteQty;
  if (inputQty <= 0) throw new ApiError(400, 'Enter how much was used');
  if (matching && outputQty + wasteQty - inputQty > 1e-6) {
    throw new ApiError(400, 'Made plus waste cannot be more than what was used');
  }
  if (matching && inputQty - (outputQty + wasteQty) > 1e-6) {
    throw new ApiError(400, 'Used cannot be more than made plus waste');
  }

  const taken = inputQty;
  let createdPickup = false;
  if (!pickup) {
    const match = chooseLot(lots, payload, taken);
    await pickupLot(user, {
      orderId: String(order._id),
      itemId: String(item._id),
      stage,
      lotId: match.id,
      qty: taken,
    });
    createdPickup = true;
  } else if (taken - pickup.qty > 1e-6) {
    throw new ApiError(400, `Only ${qtyText(pickup.qty)} ${pickup.unit} is taken for this line. Enter that much or less.`);
  }

  try {
    return await completeStage(user, {
    orderId: String(order._id),
    itemId: String(item._id),
    stage,
    machineId: payload.machineId,
    inputQty,
    outputQty,
    wasteQty,
    workDate: payload.workDate,
    notes: payload.notes,
    vehicleNumber: payload.vehicleNumber,
    handoverPerson: payload.handoverPerson,
    deliveryPartner: payload.deliveryPartner,
    details: payload.details,
  });
  } catch (error) {
    if (createdPickup) {
      await releasePickup(user, {
        orderId: String(order._id),
        itemId: String(item._id),
        stage,
      }).catch(() => {});
    }
    throw error;
  }
}

const EDITABLE_ORDER_STATUSES = [...FLOOR_ORDER_STATUSES, SALES_ORDER_STATUSES.DELIVERED];
const EPS = 1e-6;

async function loadEntry(user, payload) {
  const order = await salesOrderRepo.findById(payload.orderId);
  if (!order) throw new ApiError(404, 'Order not found');
  if (!EDITABLE_ORDER_STATUSES.includes(order.status)) {
    throw new ApiError(400, 'Entries cannot be changed once the order is completed or cancelled');
  }
  const registers = require('../register/register.service');
  const { doc, entry } = await registers.findEntry(order, payload.entryId);
  if (!canWorkStage(user, entry.stage)) {
    throw new ApiError(403, 'You cannot change entries on this stage');
  }
  const { item, row } = registers.workRowFor(order, entry);
  if (!item || !row) throw new ApiError(404, 'The production record for this entry was not found');
  assertMayChangeEntry(user, order, row);
  return { order, doc, entry, item, row, stage: entry.stage, registers };
}

// Operators may fix their own entries for a short while; anything older,
// anyone else's, or anything on a delivered order needs a manager.
const OPERATOR_EDIT_HOURS = Number(process.env.OPERATOR_EDIT_HOURS) || 24;

function isFloorManager(user, stage) {
  if (isProductionManager(user)) return true;
  return isDeliveryStage(stage) && hasPermission(user, 'dispatch:update');
}

function assertMayChangeEntry(user, order, row) {
  // A delivered order's entries (dispatch rows included) need a production
  // manager: dispatch:update alone is not enough once goods have left.
  if (order.status === SALES_ORDER_STATUSES.DELIVERED && !isProductionManager(user)) {
    throw new ApiError(403, 'This order is delivered. Ask a production manager to change its entries.');
  }
  if (isFloorManager(user, row.stage)) return;
  if (String(row.operator || '') !== String(user._id)) {
    throw new ApiError(403, 'You can only change entries you made. Ask a production manager.');
  }
  const madeAt = new Date(row.completedAt || row.workDate || 0).getTime();
  if (!madeAt || Date.now() - madeAt > OPERATOR_EDIT_HOURS * 60 * 60 * 1000) {
    throw new ApiError(403, `Entries can be changed for ${OPERATOR_EDIT_HOURS} hours. Ask a production manager.`);
  }
}

// Quantity of a line on issued sale invoices of this order.
async function invoicedQty(order, item) {
  const Invoice = require('../billing/invoice.model');
  const invoices = await Invoice.find({ salesOrder: order._id, status: 'issued', kind: 'sale' }).select('lines').lean();
  let total = 0;
  for (const invoice of invoices) {
    for (const line of invoice.lines || []) {
      if (String(line.itemId) === String(item._id)) total += Number(line.quantity) || 0;
    }
  }
  return total;
}

// Dispatch rows are what billing invoices against: the dispatched total may
// never drop below what is already on issued invoices.
async function assertDispatchCoversInvoices(order, item, newDispatched) {
  const invoiced = await invoicedQty(order, item);
  if (invoiced - newDispatched > EPS) {
    throw new ApiError(
      400,
      `${qtyText(invoiced)} ${item.unit || 'pcs'} of this line is already invoiced. Cancel or credit the invoice before reducing the dispatch below that.`
    );
  }
}

async function findWorkLot(order, item, row, category) {
  const linked = category === INVENTORY_CATEGORIES.WASTE ? row.wasteLot : row.outputLot;
  if (linked) return itemRepo.findById(linked);
  const qty = category === INVENTORY_CATEGORIES.WASTE ? Number(row.wasteQty) || 0 : Number(row.outputQty) || 0;
  const lots = await itemRepo.findAll({
    kind: 'wip',
    category,
    salesOrder: order._id,
    lineItem: item._id,
    wipStage: row.stage,
  });
  return lots.find((lot) => Number(lot.quantity) + EPS >= qty) || lots[0] || null;
}

async function findSourceLot(order, item, row) {
  if (row.sourceLot) {
    const linked = await itemRepo.findById(row.sourceLot);
    if (linked) return linked;
  }
  if (!row.pickedLotName) return null;
  const sameOrder = await itemRepo.findOne({ name: row.pickedLotName, salesOrder: order._id, lineItem: item._id });
  if (sameOrder) return sameOrder;
  // Raw store lots are shared, but only trust a name match when it is unique.
  if (row.fromStage) return null;
  const byName = await itemRepo.findAll({ name: row.pickedLotName, kind: { $ne: 'wip' } });
  return byName.length === 1 ? byName[0] : null;
}

async function restoreSource(order, item, row, qty, unit) {
  if (qty <= EPS) return () => {};
  const lot = await findSourceLot(order, item, row);
  if (lot) {
    await itemRepo.addQuantity(lot._id, qty);
    if (lot.isActive === false) await itemRepo.updateById(lot._id, { isActive: true });
    return () => itemRepo.takeQuantity(lot._id, qty);
  }
  const fromStage = row.fromStage || '';
  const created = await itemRepo.create({
    category: fromStage ? INVENTORY_CATEGORIES.OUTPUT : INVENTORY_CATEGORIES.RAW,
    name: row.pickedLotName || `${order.number} returned`,
    materialType: item.material || item.manufacturing?.materialType || 'WIP',
    unit: unit || item.unit || 'pcs',
    quantity: qty,
    unitPrice: fromStage ? 0 : null,
    notes: `Returned from a changed entry on ${order.number}`,
    isActive: true,
    kind: fromStage ? 'wip' : 'catalog',
    wipStage: fromStage,
    salesOrder: fromStage ? order._id : null,
    lineItem: fromStage ? item._id : null,
  });
  return () => itemRepo.deleteById(created._id);
}

async function takeBack(lot, qty, message) {
  if (qty <= EPS) return;
  if (!lot) throw new ApiError(400, message);
  const updated = await itemRepo.takeQuantity(lot._id, qty, { allowNegative: canGoNegative(lot) });
  if (!updated) throw new ApiError(400, message);
}

async function dropEmptyLot(lotId) {
  if (!lotId) return;
  const lot = await itemRepo.findById(lotId);
  if (lot && lot.kind === 'wip' && Number(lot.quantity) <= EPS) await itemRepo.deleteById(lot._id);
}

const USED_DOWNSTREAM = 'The next stage has already used this output. Change or delete those entries first.';

async function deleteEntry(user, payload) {
  const { order, doc, entry, item, row, stage, registers } = await loadEntry(user, payload);
  const outputQty = Number(row.outputQty) || 0;
  const wasteQty = Number(row.wasteQty) || 0;
  const inputQty = Number(row.inputQty) || 0;
  const undo = [];
  let settled = [];

  if (isDeliveryStage(stage)) {
    await assertDispatchCoversInvoices(order, item, stageStats(item, stage).output - outputQty);
  }

  try {
    if (!isDeliveryStage(stage)) {
      const outputLot = await findWorkLot(order, item, row, INVENTORY_CATEGORIES.OUTPUT);
      await takeBack(outputLot, outputQty, USED_DOWNSTREAM);
      undo.push(() => itemRepo.addQuantity(outputLot._id, outputQty));
      if (wasteQty > EPS) {
        const wasteLot = await findWorkLot(order, item, row, INVENTORY_CATEGORIES.WASTE);
        const available = Math.min(wasteQty, Number(wasteLot?.quantity) || 0);
        if (wasteLot && available > EPS) {
          await itemRepo.takeQuantity(wasteLot._id, available);
          undo.push(() => itemRepo.addQuantity(wasteLot._id, available));
        }
      }
    }

    // A step that took nothing from stock has nothing to put back.
    if (!takesNoStock(item.productionRoute, stage)) {
      const prevStage = previousStage(item.productionRoute, stage);
      const sourceUnit = prevStage ? stageUnit(item, prevStage) : undefined;
      undo.push(await restoreSource(order, item, row, inputQty, sourceUnit));
    }

    const outputLotId = row.outputLot;
    const wasteLotId = row.wasteLot;
    item.stageWork.pull(row._id);
    item.currentStage = activeStage(item);
    settled = applyOrderStatus(order);
    await salesOrderRepo.save(order);
  } catch (error) {
    for (const step of undo.reverse()) await Promise.resolve(step()).catch(logUndoFailure);
    throw error;
  }
  // The order is saved; from here on, inventory must not be rolled back.
  await returnSettledPickups(order, settled);
  await syncTasks(order, user);
  await afterCommit(() => {
    doc.$session(null); // loaded inside the (now finished) transaction
    return registers.removeEntry(doc, entry);
  }).catch((error) => console.error('Register entry removal failed; rebuilt on next open', error.message));
  await dropEmptyLot(row.outputLot).catch(() => {});
  await dropEmptyLot(row.wasteLot).catch(() => {});
  return { deleted: true };
}

async function updateEntry(user, payload) {
  const { order, doc, entry, item, row, stage, registers } = await loadEntry(user, payload);
  const delivery = isDeliveryStage(stage);
  const oldOut = Number(row.outputQty) || 0;
  const oldWaste = Number(row.wasteQty) || 0;
  const oldIn = Number(row.inputQty) || 0;

  const outputQty = payload.outputQty === undefined || payload.outputQty === '' ? oldOut : num(payload.outputQty);
  const wasteQty = delivery ? 0 : payload.wasteQty === undefined || payload.wasteQty === '' ? oldWaste : num(payload.wasteQty);
  if (outputQty <= 0) throw new ApiError(400, 'Enter the production quantity');
  if (wasteQty < 0) throw new ApiError(400, 'Waste cannot be negative');

  const stats = stageStats(item, stage);
  const cap = stats.target - (stats.output - oldOut);
  if (stats.capped && outputQty - cap > EPS) {
    throw new ApiError(400, `Only ${qtyText(cap)} ${stats.unit} can be entered on this stage`);
  }

  const prevStage = previousStage(item.productionRoute, stage);
  const noStock = takesNoStock(item.productionRoute, stage);
  const sourceLot = noStock ? null : await findSourceLot(order, item, row);
  const sourceUnit = sourceLot?.unit || (prevStage ? stageUnit(item, prevStage) : stats.unit);
  const matching = !delivery && sameUnit(sourceUnit, stats.unit);
  // The unit the row's waste was recorded in; old rows without one get the
  // unit of what was used.
  const keptWasteUnit = String((typeof row.get === 'function' ? row.get('wasteUnit') : row.wasteUnit) || '').trim();
  const rowWasteUnit = keptWasteUnit || (matching ? stats.unit : sourceUnit || stats.unit);
  const givenInput = !(payload.inputQty === undefined || payload.inputQty === null || payload.inputQty === '');
  let inputQty;
  if (noStock) {
    // Nothing was taken from stock: dispatch keeps 0, "other" keeps the noted figure.
    inputQty = delivery ? 0 : givenInput ? num(payload.inputQty) : oldIn;
    if (inputQty < 0) throw new ApiError(400, 'Used cannot be negative');
  } else if (delivery) {
    const deliveryMatching = sameUnit(sourceUnit, stats.unit);
    inputQty = deliveryMatching ? outputQty : givenInput ? num(payload.inputQty) : oldIn;
  } else if (matching) inputQty = outputQty + wasteQty;
  else inputQty = givenInput ? num(payload.inputQty) : oldIn;
  if (inputQty <= 0 && !noStock) throw new ApiError(400, 'Enter how much was used');

  if (delivery) {
    if (outputQty < oldOut - EPS) {
      await assertDispatchCoversInvoices(order, item, stats.output - oldOut + outputQty);
    }
    if (!noStock && !sameUnit(sourceUnit, stats.unit)) {
      assertPlausibleDispatch(user, item, sourceLot || { unit: sourceUnit }, outputQty, inputQty, stats.unit);
    }
  }

  let machine = null;
  if (payload.machineId) {
    const stageDoc = await stageRepo.findBySlug(stage);
    machine = (stageDoc?.machines || []).find((m) => String(m._id) === String(payload.machineId)) || null;
    if (!machine) throw new ApiError(400, 'That machine is not assigned to this stage');
    if (machine.isActive === false && String(machine._id) !== String(row.machine || '')) {
      throw new ApiError(400, 'That machine is inactive');
    }
  }

  const workDate = parseWorkDate(payload.workDate, row.workDate);

  if (delivery) {
    const deliveryPartner = String(payload.deliveryPartner ?? row.deliveryPartner ?? '').trim();
    if (!DELIVERY_PARTNERS.includes(deliveryPartner)) throw new ApiError(400, 'Select In-house, Delhivery, or Customer');
    if (!String(payload.handoverPerson ?? row.handoverPerson ?? '').trim()) throw new ApiError(400, 'Enter the person taking these goods');
    if (!String(payload.vehicleNumber ?? row.vehicleNumber ?? '').trim()) throw new ApiError(400, 'Enter the vehicle number');
  }

  const undo = [];
  const created = [];
  let settled = [];
  try {
    const dIn = noStock ? 0 : inputQty - oldIn;
    if (dIn > EPS) {
      await takeBack(sourceLot, dIn, `Not enough left on ${row.pickedLotName || 'the material used'} to use ${qtyText(dIn)} more`);
      undo.push(() => itemRepo.addQuantity(sourceLot._id, dIn));
    } else if (dIn < -EPS) {
      undo.push(await restoreSource(order, item, row, -dIn, sourceUnit));
    }

    if (!delivery) {
      const dOut = outputQty - oldOut;
      if (Math.abs(dOut) > EPS) {
        let outputLot = await findWorkLot(order, item, row, INVENTORY_CATEGORIES.OUTPUT);
        if (dOut < 0) {
          await takeBack(outputLot, -dOut, USED_DOWNSTREAM);
          undo.push(() => itemRepo.addQuantity(outputLot._id, -dOut));
        } else if (outputLot) {
          await itemRepo.addQuantity(outputLot._id, dOut);
          undo.push(() => itemRepo.takeQuantity(outputLot._id, dOut));
        } else {
          outputLot = await createEntryLot({ order, item, stage, category: INVENTORY_CATEGORIES.OUTPUT, qty: dOut, unit: stats.unit, workDate });
          if (outputLot) created.push(outputLot);
          row.outputLot = outputLot?._id || null;
        }
      }

      const dWaste = wasteQty - oldWaste;
      if (Math.abs(dWaste) > EPS) {
        let wasteLot = await findWorkLot(order, item, row, INVENTORY_CATEGORIES.WASTE);
        if (dWaste < 0) {
          const available = Math.min(-dWaste, Number(wasteLot?.quantity) || 0);
          if (wasteLot && available > EPS) {
            await itemRepo.takeQuantity(wasteLot._id, available);
            undo.push(() => itemRepo.addQuantity(wasteLot._id, available));
          }
        } else if (wasteLot) {
          await itemRepo.addQuantity(wasteLot._id, dWaste);
          undo.push(() => itemRepo.takeQuantity(wasteLot._id, dWaste));
        } else {
          wasteLot = await createEntryLot({
            order,
            item,
            stage,
            category: INVENTORY_CATEGORIES.WASTE,
            qty: dWaste,
            unit: rowWasteUnit,
            workDate,
          });
          if (wasteLot) created.push(wasteLot);
          row.wasteLot = wasteLot?._id || null;
        }
      }
    }

    row.inputQty = inputQty;
    row.outputQty = outputQty;
    row.wasteQty = wasteQty;
    row.workDate = workDate;
    if (!delivery && wasteQty > 0) setWasteUnit(row, rowWasteUnit);
    if (machine) {
      row.machine = machine._id;
      row.machineName = `${machine.name}${machine.code ? ` (${machine.code})` : ''}`;
    }
    if (payload.notes !== undefined) row.notes = String(payload.notes || '').trim();
    if (delivery) {
      row.deliveryPartner = String(payload.deliveryPartner ?? row.deliveryPartner ?? '').trim();
      row.handoverPerson = String(payload.handoverPerson ?? row.handoverPerson ?? '').trim();
      row.vehicleNumber = String(payload.vehicleNumber ?? row.vehicleNumber ?? '').trim();
    }
    if (payload.details && typeof payload.details === 'object') {
      row.details = buildDetails(order, item, stage, payload.details);
      if (!delivery && wasteQty && !row.details.wastage) row.details.wastage = String(wasteQty);
    }
    item.markModified('stageWork');
    item.currentStage = activeStage(item);
    settled = applyOrderStatus(order);
    await salesOrderRepo.save(order);
  } catch (error) {
    for (const step of undo.reverse()) await Promise.resolve(step()).catch(logUndoFailure);
    for (const lot of created) await itemRepo.deleteById(lot._id).catch(() => {});
    throw error;
  }
  await returnSettledPickups(order, settled);
  await syncTasks(order, user);
  await afterCommit(() => {
    doc.$session(null); // loaded inside the (now finished) transaction
    return registers.updateEntry(doc, entry, item, row);
  }).catch((error) => console.error('Register entry update failed; rebuilt on next open', error.message));
  return { updated: true };
}

// A production manager closes a stage that came in under target: it counts as
// done with what it made, and the next stages close once they have used all
// of it (see stageStats).
async function closeStageShort(user, payload) {
  if (!isProductionManager(user)) {
    throw new ApiError(403, 'Only a production manager can close a stage short');
  }
  const { order, item, stage } = await loadFloorItem(user, payload, { mustWork: true });
  if (isDeliveryStage(stage)) {
    throw new ApiError(400, 'Dispatch cannot be closed short. Close the last making stage instead.');
  }
  const reason = String(payload.reason || '').trim().slice(0, 500);
  if (reason.length < 3) throw new ApiError(400, 'Enter why this stage is being closed short');
  const stats = stageStats(item, stage);
  if (isStageClosed(item, stage) || stats.done) throw new ApiError(400, `${stageTitle(stage)} is already done on this line`);
  if (!(stats.output > 0)) throw new ApiError(400, `Nothing has been made at ${stageTitle(stage)} yet`);
  if (toPublicPickup(item, stage)) {
    throw new ApiError(400, 'Finish or return the lot marked for working at this stage first');
  }
  const prev = previousStage(item.productionRoute, stage);
  if (prev && !stageStats(item, prev).done) {
    throw new ApiError(400, `${stageTitle(prev)} is not done yet. Close it first.`);
  }

  const closed = [
    ...closedStages(item).map((row) => (row && typeof row.toObject === 'function' ? row.toObject() : row)),
    { stage, by: user._id, byName: user.fullName || user.username || '', at: new Date(), reason },
  ];
  // stageClosed is not declared on the order item schema yet; strict: false
  // stores it either way (a plain assignment works once it is declared).
  item.set('stageClosed', closed, { strict: false });
  item.currentStage = activeStage(item);
  const settled = applyOrderStatus(order);
  await salesOrderRepo.save(order);
  await returnSettledPickups(order, settled);
  await syncTasks(order, user);
  return toJob(order, item, stage);
}

async function stageMachines(user, stage) {
  if (!canReadStage(user, stage)) {
    throw new ApiError(403, 'You cannot view this stage');
  }
  if (isDeliveryStage(stage)) return [];
  const stageDoc = await stageRepo.findBySlug(stage);
  return (stageDoc?.machines || [])
    .filter((machine) => machine.isActive !== false)
    .map((machine) => ({
      id: String(machine._id),
      name: machine.name,
      code: machine.code || '',
    }));
}

// Order saves are version-checked. When two operators touch the same order at
// once, the loser's save fails after its own stock moves were undone, so the
// whole action can safely run again against the fresh order.
function retryOnOrderConflict(action, attempts = 3) {
  return async (...args) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await action(...args);
      } catch (error) {
        if (error?.name !== 'VersionError' || attempt >= attempts) throw error;
      }
    }
  };
}

// Each floor action is one transaction: stock moves, the order save and new
// output/waste lots commit together or not at all.
function floorAction(action) {
  return retryOnOrderConflict((...args) => inTransaction(() => action(...args)));
}

module.exports = {
  listQueue,
  sourceLots: listSourceLots,
  pickupLot: floorAction(pickupLot),
  releasePickup: floorAction(releasePickup),
  completeStage: floorAction(completeStage),
  enterFromRegister: floorAction(enterFromRegister),
  updateEntry: floorAction(updateEntry),
  deleteEntry: floorAction(deleteEntry),
  closeStageShort: floorAction(closeStageShort),
  stageMachines,
  createLotCache,
  detachOrderPickups,
  releaseOrderStock,
};
