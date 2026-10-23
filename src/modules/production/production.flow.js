const { PRODUCTION_ROUTE_LIST, ROLE_SLUGS, SALES_ORDER_STATUSES } = require('../../config/constants');
const { hasPermission } = require('../../utils/permissions');

const ROUTE_BY_ID = new Map(PRODUCTION_ROUTE_LIST.map((route) => [route.id, route]));

const FLOOR_STAGES = [
  { id: 'rolling', label: 'Rolling', read: 'production:rolling:read', update: 'production:rolling:update' },
  { id: 'printing', label: 'Printing', read: 'production:printing:read', update: 'production:printing:update' },
  { id: 'cutting', label: 'Cutting', read: 'production:cutting:read', update: 'production:cutting:update' },
  // The "Other process" step (lamination, packing, ...): production managers
  // and the owner record it; there is no operator role for it.
  { id: 'other', label: 'Other process', read: 'production:read', update: 'production:update' },
  { id: 'dispatch', label: 'Dispatch', read: 'dispatch:read', update: 'dispatch:update' },
];

function isDeliveryStage(stage) {
  return stage === 'dispatch';
}

// Stages that take nothing from stock: the "other" process records its output
// without a source lot, and a dispatch with no stage before it (direct
// dispatch) sends goods that were never made here.
function takesNoStock(route, stage) {
  if (stage === 'other') return true;
  return isDeliveryStage(stage) && !previousStage(route, stage);
}

// The name shown for a stage on one line: the process typed on the order for
// "other", the stage label otherwise.
function stageName(item, stage) {
  if (stage === 'other') return String(item?.otherProcess || '').trim() || 'Other process';
  return FLOOR_STAGES.find((row) => row.id === stage)?.label || stage;
}

function isSuperAdmin(user) {
  return user?.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
}

function routeStages(route) {
  return ROUTE_BY_ID.get(route)?.stages || ['rolling', 'dispatch'];
}

function firstStage(route) {
  return routeStages(route)[0];
}

function nextStage(route, current) {
  const stages = routeStages(route);
  const index = stages.indexOf(current);
  if (index < 0) return firstStage(route);
  if (index >= stages.length - 1) return 'completed';
  return stages[index + 1];
}

function previousStage(route, current) {
  const stages = routeStages(route);
  const index = stages.indexOf(current);
  return index > 0 ? stages[index - 1] : null;
}

function lastMakeStage(route) {
  const stages = routeStages(route).filter((stage) => stage !== 'dispatch');
  return stages[stages.length - 1] || 'rolling';
}

function canReadStage(user, stage) {
  if (isSuperAdmin(user) || hasPermission(user, 'production:read')) return true;
  const meta = FLOOR_STAGES.find((item) => item.id === stage);
  return meta ? hasPermission(user, meta.read) : false;
}

function canWorkStage(user, stage) {
  if (isSuperAdmin(user) || hasPermission(user, 'production:update')) return true;
  const meta = FLOOR_STAGES.find((item) => item.id === stage);
  return meta ? hasPermission(user, meta.update) : false;
}

function visibleStages(user) {
  return FLOOR_STAGES.filter((stage) => canReadStage(user, stage.id));
}

function operatorStations(user) {
  if (
    isSuperAdmin(user) ||
    hasPermission(user, 'sales:read') ||
    hasPermission(user, 'production:read') ||
    hasPermission(user, 'accounts:read') ||
    hasPermission(user, 'inventory:read')
  ) {
    return [];
  }
  return visibleStages(user).map((stage) => stage.id);
}

function sumWork(item, stage, field) {
  return (item.stageWork || [])
    .filter((row) => row.stage === stage)
    .reduce((total, row) => total + (Number(row[field]) || 0), 0);
}

const EPS = 1e-6;

function leadingNumber(text) {
  const match = String(text ?? '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function stageUnit(item, stage) {
  if (stage === 'rolling') return 'kg';
  return item.unit || 'pcs';
}

function stageTarget(item, stage) {
  if (stage === 'rolling') {
    const weight = leadingNumber(item.manufacturing?.requiredWeight);
    if (weight > 0) return weight;
    return String(item.unit || '').toLowerCase() === 'kg' ? Number(item.quantity) || 0 : 0;
  }
  return Number(item.quantity) || 0;
}

function holdingAt(item, stage) {
  return item.stagePickup?.stage === stage && Number(item.stagePickup.qty) > 0;
}

// Reads a field that may not be declared on the order schema yet (it was
// stored with strict: false): plain and lean objects carry it directly.
function extraField(doc, key) {
  if (!doc) return undefined;
  if (doc[key] !== undefined) return doc[key];
  return typeof doc.get === 'function' ? doc.get(key) : undefined;
}

// Stages a production manager closed short ("close stage short"): they count
// as done with whatever they made, so the next stages can finish.
function closedStages(item) {
  const list = extraField(item, 'stageClosed');
  return Array.isArray(list) ? list : [];
}

function isStageClosed(item, stage) {
  return closedStages(item).some((row) => row && row.stage === stage);
}

// Waste is in the unit of what was used (kg of film at printing, pcs at
// cutting). Old rows without wasteUnit: a row whose used = made + waste is all
// in the stage unit, otherwise the waste is in the source's unit.
function wasteUnitOf(item, row) {
  const stored = String(extraField(row, 'wasteUnit') || '').trim();
  if (stored) return stored;
  const unit = stageUnit(item, row.stage);
  const input = Number(row.inputQty) || 0;
  const matching = Math.abs(input - ((Number(row.outputQty) || 0) + (Number(row.wasteQty) || 0))) < EPS;
  if (matching) return unit;
  const prev = previousStage(item.productionRoute, row.stage);
  return prev ? stageUnit(item, prev) : 'kg';
}

function round3(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

// Waste per unit, never adding kg to pcs. `waste` is the stage's main waste
// figure (in `wasteUnit`); `wasteText` lists every unit, e.g. "3 kg + 2 pcs".
function wasteSummary(item, rows) {
  const byUnit = {};
  for (const row of rows) {
    const qty = Number(row.wasteQty) || 0;
    if (!(qty > 0)) continue;
    const unit = wasteUnitOf(item, row);
    byUnit[unit] = round3((byUnit[unit] || 0) + qty);
  }
  const units = Object.keys(byUnit);
  const main = units.length === 1 ? units[0] : units.length ? units.sort((a, b) => byUnit[b] - byUnit[a])[0] : '';
  return {
    byUnit,
    unit: main,
    qty: main ? byUnit[main] : 0,
    text: units.map((unit) => `${byUnit[unit]} ${unit}`).join(' + '),
  };
}

function stageStats(item, stage) {
  const target = stageTarget(item, stage);
  const input = sumWork(item, stage, 'inputQty');
  const output = sumWork(item, stage, 'outputQty');
  const wastes = wasteSummary(item, (item.stageWork || []).filter((row) => row.stage === stage));
  const holding = holdingAt(item, stage);
  const prev = previousStage(item.productionRoute, stage);
  const closedShort = isStageClosed(item, stage);

  let done = target > 0 && output + EPS >= target;
  if (!done && closedShort && !holding) done = true;
  if (!done && prev) {
    const before = stageStats(item, prev);
    done = before.done && before.output > 0 && input + EPS >= before.output && !holding;
  }
  if (!done && !prev) {
    // The first stage also closes once the next stage has made its full quantity, even if it came in under target.
    const following = nextStage(item.productionRoute, stage);
    const followingTarget = following && following !== 'completed' ? stageTarget(item, following) : 0;
    const followingDone = followingTarget > 0 && sumWork(item, following, 'outputQty') + EPS >= followingTarget;
    const noFollowing = !following || following === 'completed';
    done = output > 0 && !holding && (target <= 0 ? noFollowing || followingDone : followingDone);
  }

  return {
    stage,
    unit: stageUnit(item, stage),
    target,
    capped: target > 0,
    input,
    output,
    waste: wastes.qty,
    wasteUnit: wastes.unit || stageUnit(item, stage),
    wasteByUnit: wastes.byUnit,
    wasteText: wastes.text,
    remaining: done ? 0 : Math.max(0, target - output),
    done,
    closedShort: closedShort && !(target > 0 && output + EPS >= target),
  };
}

function availableFromPrevious(item, stage) {
  const prev = previousStage(item.productionRoute, stage);
  if (!prev) return null;
  return Math.max(0, stageStats(item, prev).output - stageStats(item, stage).input);
}

const FLOOR_ORDER_STATUSES = [
  SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
  SALES_ORDER_STATUSES.IN_PRODUCTION,
  SALES_ORDER_STATUSES.READY_FOR_PACKING,
  SALES_ORDER_STATUSES.PACKED,
  SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
  SALES_ORDER_STATUSES.DISPATCHED,
];

function itemVisibleAtStage(item, stage, orderStatus) {
  if (!FLOOR_ORDER_STATUSES.includes(orderStatus)) return false;
  if (!routeStages(item.productionRoute).includes(stage)) return false;
  const stats = stageStats(item, stage);
  const holding = item.stagePickup?.stage === stage && Number(item.stagePickup.qty) > 0;
  if (stats.done) return holding;
  if (holding) return true;
  const prev = previousStage(item.productionRoute, stage);
  if (!prev) return true;
  return availableFromPrevious(item, stage) > 0 || stats.output > 0 || stats.input > 0;
}

function activeStage(item) {
  const stages = routeStages(item.productionRoute);
  for (const stage of stages) {
    if (!stageStats(item, stage).done) return stage;
  }
  return 'completed';
}

function syncOrderStatus(order) {
  const items = order.items || [];
  if (!items.length) return order.status;
  if (items.every((item) => activeStage(item) === 'completed')) return SALES_ORDER_STATUSES.DELIVERED;

  const open = items.map((item) => activeStage(item)).filter((stage) => stage !== 'completed');
  if (open.length && open.every((stage) => stage === 'dispatch')) {
    const sentAny = items.some((item) => sumWork(item, 'dispatch', 'outputQty') > 0);
    return sentAny ? SALES_ORDER_STATUSES.DISPATCHED : SALES_ORDER_STATUSES.READY_FOR_DISPATCH;
  }

  const anyWork = items.some((item) => (item.stageWork || []).length > 0);
  if (anyWork) return SALES_ORDER_STATUSES.IN_PRODUCTION;
  if (items.some((item) => item.currentStage)) return SALES_ORDER_STATUSES.PRODUCTION_PLANNED;
  return order.status;
}

function itemProgress(item, status) {
  const stages = routeStages(item.productionRoute);
  const planned =
    Boolean(item.currentStage) ||
    ['production_planned', 'in_production', 'ready_for_dispatch', 'dispatched', 'delivered', 'completed'].includes(status);

  return ['approved', 'planned', ...stages].map((step) => {
    if (step === 'approved') {
      return { step, done: !['draft', 'submitted', 'cancelled'].includes(status) };
    }
    if (step === 'planned') {
      return { step, done: planned };
    }
    const stats = stageStats(item, step);
    return {
      step,
      done: stats.done,
      outputQty: stats.output,
      remaining: stats.remaining,
      target: stats.target,
    };
  });
}

function previousOutput(item, stage) {
  const prev = previousStage(item.productionRoute, stage);
  if (!prev) return null;
  const stats = stageStats(item, prev);
  return {
    stage: prev,
    unit: stats.unit,
    outputQty: stats.output,
    availableQty: availableFromPrevious(item, stage),
    wasteQty: stats.waste,
    wasteUnit: stats.wasteUnit,
    wasteText: stats.wasteText,
  };
}

function registerSpecs(order, item, stage) {
  const roll = item.roll || {};
  const rollSize = roll.size || [roll.width, roll.length].filter(Boolean).join(' × ') || '';
  if (stage === 'rolling') {
    return {
      rollSize,
      colour: item.color || item.manufacturing?.color || '',
    };
  }
  if (stage === 'printing') {
    return {
      rollSize,
      jobSize: item.size || '',
      impression: item.printing?.impressions || '',
      colorUsed: item.printing?.colors || item.color || '',
      artwork: item.printing?.artwork || item.printing?.requirement || item.printing?.design || '',
    };
  }
  if (stage === 'other') {
    return { process: stageName(item, stage) };
  }
  if (stage === 'cutting') {
    const bag = item.bag || {};
    const holes = item.holes || {};
    return {
      rollSize,
      size: bag.size || [bag.width, bag.length].filter(Boolean).join(' × ') || item.size || '',
      hole: holes.required ? [holes.count, holes.type, holes.size].filter(Boolean).join(' ') : '',
    };
  }
  return {};
}

function stageRequirements(order, item, stage) {
  const incoming = previousOutput(item, stage);
  const stats = stageStats(item, stage);
  const common = {
    product: item.product || '',
    productCode: item.productCode || '',
    size: item.size || '',
    quantity: stats.target,
    unit: stats.unit,
    color: item.color || item.manufacturing?.color || '',
    produced: stats.output,
    remaining: stats.remaining,
    availableInput: incoming ? incoming.availableQty : null,
    incomingOutput: incoming,
  };

  if (stage === 'rolling') {
    return {
      ...common,
      material: item.material || item.manufacturing?.rawMaterial || '',
      thickness: item.thickness || item.manufacturing?.thickness || '',
      materialType: item.manufacturing?.materialType || '',
      materialGrade: item.manufacturing?.materialGrade || '',
      requiredWeight: item.manufacturing?.requiredWeight || '',
      width: item.width || item.manufacturing?.width || '',
      length: item.length || item.manufacturing?.length || '',
      additives: item.manufacturing?.additives || '',
      roll: item.roll || {},
      specialRequirements: item.manufacturing?.specialRequirements || '',
    };
  }

  if (stage === 'printing') {
    return {
      ...common,
      printing: item.printing || {},
      specialRequirements: item.manufacturing?.specialRequirements || '',
    };
  }

  if (stage === 'other') {
    return {
      ...common,
      process: stageName(item, stage),
      material: item.material || '',
      specialRequirements: item.manufacturing?.specialRequirements || '',
    };
  }

  if (stage === 'cutting') {
    return {
      ...common,
      bag: item.bag || {},
      holes: item.holes || {},
      tape: item.tape || {},
      specialRequirements: item.manufacturing?.specialRequirements || '',
    };
  }

  return {
    ...common,
    customerCode: order.customerSnapshot?.code || order.customer?.code || '',
    deliveryDate: order.deliveryDate || null,
    deliveryLocation: order.deliveryLocation || '',
    deliveryInstructions: order.deliveryInstructions || '',
  };
}

module.exports = {
  FLOOR_STAGES,
  FLOOR_ORDER_STATUSES,
  isDeliveryStage,
  takesNoStock,
  stageName,
  ROUTE_BY_ID,
  isSuperAdmin,
  routeStages,
  firstStage,
  nextStage,
  previousStage,
  lastMakeStage,
  canReadStage,
  canWorkStage,
  visibleStages,
  operatorStations,
  stageStats,
  closedStages,
  isStageClosed,
  wasteUnitOf,
  wasteSummary,
  stageUnit,
  stageTarget,
  availableFromPrevious,
  itemVisibleAtStage,
  activeStage,
  syncOrderStatus,
  itemProgress,
  previousOutput,
  stageRequirements,
  registerSpecs,
};
