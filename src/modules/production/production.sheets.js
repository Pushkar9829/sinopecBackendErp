const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { SALES_ORDER_STATUSES } = require('../../config/constants');
const SalesOrder = require('../salesOrder/salesOrder.model');
const { FLOOR_STAGES, FLOOR_ORDER_STATUSES, isSuperAdmin, routeStages, canReadStage, visibleStages, stageStats, activeStage, stageRequirements } = require('./production.flow');

// Printable sheets for the floor: the job sheet of one order (one page per
// stage, with the specs that stage needs and blank rows to write the shift's
// figures in) and the work list of one stage (every line waiting there).

const STAGE_LABEL = Object.fromEntries(FLOOR_STAGES.map((s) => [s.id, s.label]));
const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2 };
const MAX_INLINE_IMAGE = 300 * 1024;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const join = (...parts) => parts.filter((p) => p !== undefined && p !== null && String(p).trim() !== '').join(' × ');

// Only the owner sees customer names on the floor; everyone else the code.
function customerFor(user, order) {
  const snap = order.customerSnapshot || {};
  return isSuperAdmin(user) ? snap.companyName || snap.name || snap.code || '' : snap.code || '';
}

function imagesOf(item) {
  const list = [...(item.images || []), item.image].filter(Boolean);
  return list
    .map((img) => img.url || (img.dataUrl && img.dataUrl.length <= MAX_INLINE_IMAGE ? img.dataUrl : ''))
    .filter(Boolean)
    .slice(0, 4);
}

// The specs a stage works to, as label/value pairs (empty ones left out).
function specRows(order, item, stage) {
  const req = stageRequirements(order, item, stage);
  const rows = [
    ['Product', [req.product, req.productCode && req.productCode !== req.product ? `(${req.productCode})` : ''].filter(Boolean).join(' ')],
    ['Size', req.size],
    ['Colour', req.color],
  ];
  if (stage === 'rolling') {
    rows.push(
      ['Material', [req.material, req.materialType, req.materialGrade].filter(Boolean).join(' · ')],
      ['Gauge', req.thickness],
      ['Width × length', join(req.width, req.length)],
      ['Weight to make', req.requiredWeight],
      ['Roll', req.roll?.size || join(req.roll?.width, req.roll?.length)],
      ['Roll weight', req.roll?.weight],
      ['Additives', req.additives]
    );
  } else if (stage === 'printing') {
    const p = req.printing || {};
    rows.push(['Colours', [p.colorCount && `${p.colorCount} colour(s)`, p.colors].filter(Boolean).join(': ')], ['Impressions', p.impressions], ['Design', p.design], ['Artwork', p.artwork], ['Printing notes', p.requirement || p.specialRequirements]);
  } else if (stage === 'cutting') {
    const bag = req.bag || {};
    const holes = req.holes || {};
    rows.push(
      ['Bag size', bag.size || join(bag.width, bag.length)],
      ['Gusset', bag.gusset],
      ['Holes', holes.required ? [holes.count, holes.type, holes.size, holes.position && `at ${holes.position}`].filter(Boolean).join(' ') : 'No holes'],
      ['Tape', req.tape?.required ? req.tape.type || 'Yes' : '']
    );
  } else {
    rows.push(['Deliver to', req.deliveryLocation], ['Delivery notes', req.deliveryInstructions]);
  }
  // Special requirements are often copied into the stage's own notes; show them once.
  const special = String(req.specialRequirements || '').trim();
  if (special && !rows.some(([, value]) => String(value || '').trim() === special)) rows.push(['Special requirements', special]);
  return rows.filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '').map(([label, value]) => ({ label, value: String(value) }));
}

function lineFor(order, item, stage) {
  const stats = stageStats(item, stage);
  return {
    itemId: String(item._id),
    product: item.product || item.productCode || '',
    productCode: item.productCode || '',
    unit: stats.unit,
    target: r2(stats.target),
    done: r2(stats.output),
    waste: r2(stats.waste),
    remaining: r2(stats.remaining),
    finished: stats.done,
    specs: specRows(order, item, stage),
    images: stage === 'printing' || stage === 'cutting' ? imagesOf(item) : [],
    entries: (item.stageWork || [])
      .filter((w) => w.stage === stage)
      .map((w) => ({ date: w.workDate || w.completedAt, operator: w.operatorName || '', machine: w.machineName || '', input: r2(w.inputQty), output: r2(w.outputQty), waste: r2(w.wasteQty), vehicle: w.vehicleNumber || '' })),
  };
}

async function jobSheet(user, orderId, { stage } = {}) {
  if (!mongoose.isValidObjectId(orderId)) throw new ApiError(404, 'Order not found');
  const order = await SalesOrder.findById(orderId).lean();
  if (!order || order.status === SALES_ORDER_STATUSES.DRAFT) throw new ApiError(404, 'Order not found');
  const onRoute = new Set((order.items || []).flatMap((item) => routeStages(item.productionRoute)));
  const wanted = FLOOR_STAGES.map((s) => s.id).filter((s) => onRoute.has(s) && canReadStage(user, s) && (!stage || s === stage));
  if (!wanted.length) throw new ApiError(stage && onRoute.has(stage) ? 403 : 404, stage ? 'No job sheet for this stage' : 'You cannot see any stage of this order');
  return {
    order: {
      id: String(order._id),
      number: order.number,
      orderType: order.orderType,
      status: order.status,
      priority: order.priority,
      orderDate: order.orderDate,
      deliveryDate: order.deliveryDate,
      customer: customerFor(user, order),
      productionInstructions: order.productionInstructions || '',
      remarks: order.remarks || '',
    },
    stages: wanted.map((s) => ({
      stage: s,
      label: STAGE_LABEL[s],
      lines: (order.items || []).filter((item) => routeStages(item.productionRoute).includes(s)).map((item) => lineFor(order, item, s)),
    })),
    printedAt: new Date(),
    printedBy: user.fullName || user.username || '',
  };
}

// Every line waiting at (or being worked at) a stage now, urgent and soonest first.
async function stageSheet(user, stage) {
  if (!FLOOR_STAGES.some((s) => s.id === stage)) throw new ApiError(400, 'Unknown stage');
  if (!canReadStage(user, stage)) throw new ApiError(403, 'You cannot see this stage');
  const orders = await SalesOrder.find({ status: { $in: [SALES_ORDER_STATUSES.APPROVED, ...FLOOR_ORDER_STATUSES] } }).lean();
  const lines = [];
  for (const order of orders) {
    for (const item of order.items || []) {
      if (!routeStages(item.productionRoute).includes(stage) || activeStage(item) !== stage) continue;
      const line = lineFor(order, item, stage);
      lines.push({
        id: `${order._id}:${item._id}`,
        orderId: String(order._id),
        number: order.number,
        orderType: order.orderType,
        priority: order.priority,
        deliveryDate: order.deliveryDate,
        customer: customerFor(user, order),
        started: line.entries.length > 0,
        ...line,
        entries: undefined,
        images: [],
      });
    }
  }
  lines.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3) || new Date(a.deliveryDate || '2999-01-01') - new Date(b.deliveryDate || '2999-01-01'));
  return { stage, label: STAGE_LABEL[stage], stages: visibleStages(user).map((s) => ({ id: s.id, label: s.label })), lines, printedAt: new Date(), printedBy: user.fullName || user.username || '' };
}

module.exports = { jobSheet, stageSheet, specRows };
