const { PRODUCTION_ROUTE_LIST, ROLE_SLUGS, SALES_ORDER_STATUSES } = require('../../config/constants');
const { hasPermission } = require('../../utils/permissions');

const ROUTE_BY_ID = new Map(PRODUCTION_ROUTE_LIST.map((route) => [route.id, route]));

const FLOOR_STAGES = [
  { id: 'rolling', label: 'Rolling', read: 'production:rolling:read', update: 'production:rolling:update' },
  { id: 'printing', label: 'Printing', read: 'production:printing:read', update: 'production:printing:update' },
  { id: 'cutting', label: 'Cutting', read: 'production:cutting:read', update: 'production:cutting:update' },
  { id: 'dispatch', label: 'Dispatch', read: 'dispatch:read', update: 'dispatch:update' },
];

function isDeliveryStage(stage) {
  return stage === 'dispatch';
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

function stageStats(item, stage) {
  const target = stageTarget(item, stage);
  const input = sumWork(item, stage, 'inputQty');
  const output = sumWork(item, stage, 'outputQty');
  const waste = sumWork(item, stage, 'wasteQty');
  const holding = holdingAt(item, stage);
  const prev = previousStage(item.productionRoute, stage);

  let done = target > 0 && output + EPS >= target;
  if (!done && prev) {
    const before = stageStats(item, prev);
    done = before.done && before.output > 0 && input + EPS >= before.output && !holding;
  }
  if (!done && !prev && target <= 0) {
    // No weight target: rolling stays open until the next stage has made its full quantity.
    const following = nextStage(item.productionRoute, stage);
    const followingTarget = following && following !== 'completed' ? stageTarget(item, following) : 0;
    done =
      output > 0 &&
      !holding &&
      (!following || following === 'completed' || (followingTarget > 0 && sumWork(item, following, 'outputQty') + EPS >= followingTarget));
  }

  return {
    stage,
    unit: stageUnit(item, stage),
    target,
    capped: target > 0,
    input,
    output,
    waste,
    remaining: done ? 0 : Math.max(0, target - output),
    done,
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
    outputQty: stats.output,
    availableQty: availableFromPrevious(item, stage),
    wasteQty: stats.waste,
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
      artwork: item.printing?.artwork || item.printing?.design || '',
    };
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
      material: item.material || '',
      thickness: item.thickness || item.manufacturing?.thickness || '',
      rawMaterial: item.manufacturing?.rawMaterial || '',
      materialType: item.manufacturing?.materialType || '',
      materialGrade: item.manufacturing?.materialGrade || '',
      requiredWeight: item.manufacturing?.requiredWeight || '',
      requiredQuantity: item.manufacturing?.requiredQuantity || '',
      width: item.manufacturing?.width || item.width || '',
      length: item.manufacturing?.length || item.length || '',
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
