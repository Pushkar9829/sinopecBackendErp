const { INVENTORY_CATEGORIES, PRODUCTION_SHIFTS, DELIVERY_PARTNERS, SALES_ORDER_STATUSES } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const itemRepo = require('../inventory/item.repo');
const stageRepo = require('../inventory/stage.repo');
const machineRepo = require('../machine/machine.repo');
const salesOrderRepo = require('../salesOrder/salesOrder.repo');
const {
  FLOOR_STAGES,
  activeStage,
  availableFromPrevious,
  canReadStage,
  canWorkStage,
  isDeliveryStage,
  itemVisibleAtStage,
  previousStage,
  routeStages,
  stageRequirements,
  stageStats,
  syncOrderStatus,
  visibleStages,
} = require('./production.flow');

const SHIFT_IDS = PRODUCTION_SHIFTS.map((item) => item.id);

function applyOrderStatus(order) {
  order.status = syncOrderStatus(order);
  if (order.status === SALES_ORDER_STATUSES.DELIVERED && !order.completedAt) {
    order.completedAt = new Date();
  }
  if (order.status === SALES_ORDER_STATUSES.COMPLETED && !order.completedAt) {
    order.completedAt = new Date();
  }
}

function num(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toPublicWork(row) {
  return {
    stage: row.stage,
    machineId: row.machine ? String(row.machine) : '',
    machineName: row.machineName || '',
    operatorName: row.operatorName || '',
    inputQty: row.inputQty || 0,
    outputQty: row.outputQty || 0,
    wasteQty: row.wasteQty || 0,
    shift: row.shift || 'morning',
    workDate: row.workDate || row.completedAt,
    notes: row.notes || '',
    fromStage: row.fromStage || '',
    pickedLotName: row.pickedLotName || '',
    vehicleNumber: row.vehicleNumber || '',
    handoverPerson: row.handoverPerson || '',
    deliveryPartner: row.deliveryPartner || '',
    completedAt: row.completedAt,
  };
}

function stageTitle(stage) {
  if (!stage) return 'Store';
  return FLOOR_STAGES.find((item) => item.id === stage)?.label || stage;
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

async function listSourceLots(order, item, stage) {
  const prev = previousStage(item.productionRoute, stage);
  if (!prev) {
    const rawName = String(item.manufacturing?.rawMaterial || item.material || '').toLowerCase();
    const rawItems = await itemRepo.findAll({
      category: INVENTORY_CATEGORIES.RAW,
      isActive: true,
      kind: { $ne: 'wip' },
    });
    const matched = rawItems.filter((row) => Number(row.quantity) > 0);
    const preferred = rawName
      ? matched.filter((row) => String(row.name || '').toLowerCase().includes(rawName))
      : matched;
    return (preferred.length ? preferred : matched).map((lot) => toPublicLot(lot, ''));
  }

  const lots = await itemRepo.findAll({
    salesOrder: order._id,
    lineItem: item._id,
    wipStage: prev,
    category: INVENTORY_CATEGORIES.OUTPUT,
    kind: 'wip',
  });
  return lots.filter((lot) => Number(lot.quantity) > 0).map((lot) => toPublicLot(lot, prev));
}

async function toJob(order, item, stage) {
  const stats = stageStats(item, stage);
  const availableInput = availableFromPrevious(item, stage);
  const prev = previousStage(item.productionRoute, stage);
  const sourceLots = await listSourceLots(order, item, stage);
  const pickup = toPublicPickup(item, stage);
  const readyQty = sourceLots.reduce((sum, lot) => sum + (Number(lot.quantity) || 0), 0);
  return {
    id: `${order._id}:${item._id}:${stage}`,
    orderId: String(order._id),
    itemId: String(item._id),
    stage,
    number: order.number,
    priority: order.priority,
    deliveryDate: order.deliveryDate,
    customer: order.customerSnapshot?.name || order.customer?.name || '',
    product: item.product || '',
    productCode: item.productCode || '',
    quantity: item.quantity || 0,
    unit: item.unit || 'pcs',
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
    sourceLots,
    requirements: stageRequirements(order, item, stage),
    history: (item.stageWork || []).filter((row) => row.stage === stage).map(toPublicWork),
    shifts: PRODUCTION_SHIFTS,
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

  const orders = await salesOrderRepo.findAll({
    status: {
      $in: [
        SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
        SALES_ORDER_STATUSES.IN_PRODUCTION,
        SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
        SALES_ORDER_STATUSES.DISPATCHED,
      ],
    },
  });

  const jobs = [];
  const counts = Object.fromEntries(FLOOR_STAGES.map((item) => [item.id, 0]));
  for (const order of orders) {
    for (const item of order.items || []) {
      if (itemVisibleAtStage(item, requested, order.status)) {
        jobs.push(await toJob(order, item, requested));
      }
      for (const floor of FLOOR_STAGES) {
        if (canReadStage(user, floor.id) && itemVisibleAtStage(item, floor.id, order.status)) {
          counts[floor.id] += 1;
        }
      }
    }
  }

  return {
    stage: requested,
    stages: allowed.map((item) => ({ ...item, count: counts[item.id] || 0 })),
    shifts: PRODUCTION_SHIFTS,
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
  if (!order) throw new ApiError(404, 'Sales order not found');
  if (
    ![
      SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
      SALES_ORDER_STATUSES.IN_PRODUCTION,
      SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
      SALES_ORDER_STATUSES.DISPATCHED,
    ].includes(order.status)
  ) {
    throw new ApiError(400, 'This sales order is not on the production floor');
  }

  const item = (order.items || []).id(payload.itemId);
  if (!item) throw new ApiError(404, 'Line item not found');
  if (!routeStages(item.productionRoute).includes(stage)) {
    throw new ApiError(400, 'This product does not go through that stage');
  }
  return { order, item, stage };
}

async function createShiftLot({ order, item, stage, category, qty, unit, shift, workDate }) {
  if (!stage || isDeliveryStage(stage) || qty <= 0) return null;
  const stageDoc = await stageRepo.findBySlug(stage);
  if (!stageDoc) return null;

  const suffix = category === INVENTORY_CATEGORIES.WASTE ? 'waste' : 'output';
  const when = workDate ? new Date(workDate) : new Date();
  const dateLabel = Number.isNaN(when.getTime()) ? '' : when.toISOString().slice(0, 10);
  const shiftLabel = shift ? ` · ${shift}` : '';
  const name = `${order.number} · ${item.productCode || item.product || 'item'} · ${stage} ${suffix}${shiftLabel}${dateLabel ? ` · ${dateLabel}` : ''}`;

  return itemRepo.create({
    category,
    name,
    materialType: item.material || item.manufacturing?.materialType || 'WIP',
    unit: unit || item.unit || 'pcs',
    quantity: qty,
    unitPrice: category === INVENTORY_CATEGORIES.WASTE ? null : 0,
    stage: stageDoc._id,
    notes: `From sales order ${order.number}`,
    isActive: true,
    kind: 'wip',
    wipStage: stage,
    salesOrder: order._id,
    lineItem: item._id,
  });
}

async function takeFromLot(lot, qty) {
  const onHand = Number(lot?.quantity || 0);
  if (!lot || onHand + 1e-9 < qty) {
    throw new ApiError(400, `Only ${onHand} is left on ${lot?.name || 'that lot'}.`);
  }
  lot.quantity = Math.max(0, onHand - qty);
  await lot.save();
}

async function returnToLot(lotId, qty, unit, fallback) {
  if (!lotId || qty <= 0) return;
  const lot = await itemRepo.findById(lotId);
  if (lot) {
    lot.quantity = Number(lot.quantity || 0) + qty;
    await lot.save();
    return;
  }
  if (fallback) await fallback(qty, unit);
}

async function pickupLot(user, payload) {
  const { order, item, stage } = await loadFloorItem(user, payload, { mustWork: true });
  const qty = num(payload.qty);
  if (qty <= 0) throw new ApiError(400, 'Enter how much to pick');

  const prev = previousStage(item.productionRoute, stage);
  const lot = await itemRepo.findById(payload.lotId);
  if (!lot || lot.isActive === false) throw new ApiError(400, 'That inventory lot was not found');

  if (!prev) {
    if (lot.category !== INVENTORY_CATEGORIES.RAW || lot.kind === 'wip') {
      throw new ApiError(400, 'Pick raw material from the store');
    }
  } else {
    const matches =
      lot.kind === 'wip' &&
      lot.category === INVENTORY_CATEGORIES.OUTPUT &&
      String(lot.salesOrder) === String(order._id) &&
      String(lot.lineItem) === String(item._id) &&
      lot.wipStage === prev;
    if (!matches) {
      throw new ApiError(400, `Pick ${stageTitle(prev)} output for this sales order`);
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
  applyOrderStatus(order);
  await salesOrderRepo.save(order);
  return toJob(order, item, stage);
}

async function sendDelivery(user, { order, item, stage, lot, qty, prev, payload }) {
  const vehicleNumber = String(payload.vehicleNumber || '').trim();
  const handoverPerson = String(payload.handoverPerson || '').trim();
  const deliveryPartner = String(payload.deliveryPartner || '').trim();
  if (!DELIVERY_PARTNERS.includes(deliveryPartner)) {
    throw new ApiError(400, 'Select In-house, Delhivery, or Customer');
  }
  if (!handoverPerson) throw new ApiError(400, 'Enter the person taking this delivery');
  if (!vehicleNumber) throw new ApiError(400, 'Enter the vehicle number');

  const stats = stageStats(item, stage);
  if (qty - stats.remaining > 1e-6) {
    throw new ApiError(400, `Only ${stats.remaining} left to deliver`);
  }

  const workDate = payload.workDate ? new Date(payload.workDate) : new Date();
  if (Number.isNaN(workDate.getTime())) {
    throw new ApiError(400, 'Work date is not valid');
  }

  await takeFromLot(lot, qty);
  item.stageWork = item.stageWork || [];
  item.stageWork.push({
    stage,
    machine: null,
    machineName: '',
    operator: user._id,
    operatorName: user.fullName || user.username || '',
    inputQty: qty,
    outputQty: qty,
    wasteQty: 0,
    shift: SHIFT_IDS.includes(payload.shift) ? payload.shift : 'morning',
    workDate,
    notes: String(payload.notes || '').trim(),
    fromStage: prev || '',
    pickedLotName: lot.name,
    vehicleNumber,
    handoverPerson,
    deliveryPartner,
    completedAt: new Date(),
  });
  item.currentStage = activeStage(item);
  applyOrderStatus(order);
  await salesOrderRepo.save(order);
  return toJob(order, item, stage);
}

async function releasePickup(user, payload) {
  const { order, item, stage } = await loadFloorItem(user, payload, { mustWork: true });
  const pickup = item.stagePickup;
  if (!pickup || pickup.stage !== stage || !(Number(pickup.qty) > 0)) {
    throw new ApiError(400, 'Nothing is marked for working');
  }
  await returnToLot(pickup.lot, Number(pickup.qty), pickup.unit);
  clearPickup(item);
  await salesOrderRepo.save(order);
  return toJob(order, item, stage);
}

async function completeStage(user, payload) {
  const { order, item, stage } = await loadFloorItem(user, payload, { mustWork: true });
  if (!itemVisibleAtStage(item, stage, order.status) && !stageStats(item, stage).output && !(Number(item.stagePickup?.qty) > 0)) {
    throw new ApiError(400, `Nothing is ready for ${stage} yet`);
  }

  const stats = stageStats(item, stage);
  const inputQty = num(payload.inputQty);
  const outputQty = num(payload.outputQty);
  const wasteQty = num(payload.wasteQty);
  const produced = isDeliveryStage(stage) ? outputQty || inputQty : outputQty;
  if (inputQty < 0 || outputQty < 0 || wasteQty < 0) {
    throw new ApiError(400, 'Quantities cannot be negative');
  }
  if (produced <= 0) {
    throw new ApiError(400, 'Enter how much this shift produced');
  }
  if (produced - stats.remaining > 1e-6) {
    throw new ApiError(400, `Only ${stats.remaining} left on this stage`);
  }

  const pickup = toPublicPickup(item, stage);
  if (!pickup) {
    const prev = previousStage(item.productionRoute, stage);
    throw new ApiError(
      400,
      prev ? `Pick ${stageTitle(prev)} output and mark it for working first` : 'Pick raw material and mark it for working first'
    );
  }
  if (inputQty <= 0) {
    throw new ApiError(400, 'Enter how much of the picked lot this shift used');
  }
  if (inputQty - pickup.qty > 1e-6) {
    throw new ApiError(400, `Only ${pickup.qty} is marked for working from ${pickup.lotName}`);
  }

  const vehicleNumber = String(payload.vehicleNumber || '').trim();
  const handoverPerson = String(payload.handoverPerson || '').trim();
  const deliveryPartner = String(payload.deliveryPartner || '').trim();
  if (isDeliveryStage(stage)) {
    if (!DELIVERY_PARTNERS.includes(deliveryPartner)) {
      throw new ApiError(400, 'Select In-house, Delhivery, or Customer');
    }
    if (!handoverPerson) throw new ApiError(400, 'Enter the person taking this delivery');
    if (!vehicleNumber) throw new ApiError(400, 'Enter the vehicle number');
  }

  const shift = SHIFT_IDS.includes(payload.shift) ? payload.shift : 'morning';
  const workDate = payload.workDate ? new Date(payload.workDate) : new Date();
  if (Number.isNaN(workDate.getTime())) {
    throw new ApiError(400, 'Work date is not valid');
  }

  let machine = null;
  if (payload.machineId) {
    machine = await machineRepo.findById(payload.machineId);
    if (!machine) throw new ApiError(400, 'Machine not found');
  }

  const leftover = Math.max(0, Number(item.stagePickup.qty) - inputQty);
  if (leftover > 1e-9) {
    item.stagePickup.qty = leftover;
  } else {
    clearPickup(item);
  }

  await createShiftLot({
    order,
    item,
    stage,
    category: INVENTORY_CATEGORIES.OUTPUT,
    qty: isDeliveryStage(stage) ? 0 : produced,
    unit: item.unit,
    shift,
    workDate,
  });
  await createShiftLot({
    order,
    item,
    stage,
    category: INVENTORY_CATEGORIES.WASTE,
    qty: wasteQty,
    unit: item.unit,
    shift,
    workDate,
  });

  item.stageWork = item.stageWork || [];
  item.stageWork.push({
    stage,
    machine: machine?._id || null,
    machineName: machine ? `${machine.name}${machine.code ? ` (${machine.code})` : ''}` : '',
    operator: user._id,
    operatorName: user.fullName || user.username || '',
    inputQty,
    outputQty: produced,
    wasteQty,
    shift,
    workDate,
    notes: String(payload.notes || '').trim(),
    fromStage: pickup.fromStage || '',
    pickedLotName: pickup.lotName || '',
    vehicleNumber,
    handoverPerson,
    deliveryPartner,
    completedAt: new Date(),
  });
  item.currentStage = activeStage(item);

  applyOrderStatus(order);
  await salesOrderRepo.save(order);
  return require('../salesOrder/salesOrder.service').getOrder(user, order._id);
}

async function stageMachines(user, stage) {
  if (!canReadStage(user, stage)) {
    throw new ApiError(403, 'You cannot view this stage');
  }
  if (stage === 'dispatch' || isDeliveryStage(stage)) return [];
  const stageDoc = await stageRepo.findBySlug(stage);
  return (stageDoc?.machines || [])
    .filter((machine) => machine.isActive !== false)
    .map((machine) => ({
      id: String(machine._id),
      name: machine.name,
      code: machine.code || '',
    }));
}

module.exports = {
  listQueue,
  pickupLot,
  releasePickup,
  completeStage,
  stageMachines,
};
