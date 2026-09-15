const { PRODUCTION_ROUTE_LIST, ROLE_SLUGS, SALES_ORDER_STATUSES } = require('../../config/constants');
const { hasPermission } = require('../../utils/permissions');

const ROUTE_BY_ID = new Map(PRODUCTION_ROUTE_LIST.map((route) => [route.id, route]));

const FLOOR_STAGES = [
  { id: 'rolling', label: 'Rolling', read: 'production:rolling:read', update: 'production:rolling:update' },
  { id: 'printing', label: 'Printing', read: 'production:printing:read', update: 'production:printing:update' },
  { id: 'cutting', label: 'Cutting', read: 'production:cutting:read', update: 'production:cutting:update' },
  { id: 'dispatch', label: 'Dispatch', read: 'dispatch:read', update: 'dispatch:update' },
  { id: 'delivery', label: 'Delivery', read: 'dispatch:read', update: 'dispatch:update' },
];

function isDeliveryStage(stage) {
  return stage === 'delivery';
}

function isSuperAdmin(user) {
  return user?.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
}

function routeStages(route) {
  return ROUTE_BY_ID.get(route)?.stages || ['rolling', 'dispatch', 'delivery'];
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
  const stages = routeStages(route).filter((stage) => stage !== 'dispatch' && stage !== 'delivery');
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

function stageStats(item, stage) {
  const target = Number(item.quantity) || 0;
  const input = sumWork(item, stage, 'inputQty');
  const output = sumWork(item, stage, 'outputQty');
  const waste = sumWork(item, stage, 'wasteQty');
  const remaining = Math.max(0, target - output);
  return {
    stage,
    target,
    input,
    output,
    waste,
    remaining,
    done: target > 0 ? output >= target : output > 0,
  };
}

function availableFromPrevious(item, stage) {
  const prev = previousStage(item.productionRoute, stage);
  if (!prev) return null;
  return Math.max(0, stageStats(item, prev).output - stageStats(item, stage).input);
}

function itemVisibleAtStage(item, stage, orderStatus) {
  const floor = [
    SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
    SALES_ORDER_STATUSES.IN_PRODUCTION,
    SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
    SALES_ORDER_STATUSES.DISPATCHED,
  ];
  if (!floor.includes(orderStatus)) return false;
  if (!routeStages(item.productionRoute).includes(stage)) return false;
  const stats = stageStats(item, stage);
  if (stats.done) return false;
  if (item.stagePickup?.stage === stage && Number(item.stagePickup.qty) > 0) return true;
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
  if (open.length && open.every((stage) => stage === 'delivery')) return SALES_ORDER_STATUSES.DISPATCHED;
  if (open.length && open.every((stage) => stage === 'dispatch' || stage === 'delivery')) {
    return SALES_ORDER_STATUSES.READY_FOR_DISPATCH;
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

function stageRequirements(order, item, stage) {
  const incoming = previousOutput(item, stage);
  const stats = stageStats(item, stage);
  const common = {
    product: item.product || '',
    productCode: item.productCode || '',
    size: item.size || '',
    quantity: item.quantity || 0,
    unit: item.unit || 'pcs',
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
    customer: order.customerSnapshot?.name || order.customer?.name || '',
    deliveryDate: order.deliveryDate || null,
    deliveryLocation: order.deliveryLocation || '',
    deliveryInstructions: order.deliveryInstructions || '',
  };
}

module.exports = {
  FLOOR_STAGES,
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
  availableFromPrevious,
  itemVisibleAtStage,
  activeStage,
  syncOrderStatus,
  itemProgress,
  previousOutput,
  stageRequirements,
};
