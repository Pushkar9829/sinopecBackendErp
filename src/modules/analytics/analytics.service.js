const {
  INVENTORY_CATEGORIES,
  ORDER_TYPES,
  SALES_ORDER_STATUS_FLOW,
  SALES_ORDER_STATUSES,
} = require('../../config/constants');
const SalesOrder = require('../salesOrder/salesOrder.model');
const itemRepo = require('../inventory/item.repo');
require('../inventory/stage.model');
const { hasPermission } = require('../../utils/permissions');
const { FLOOR_STAGES } = require('../production/production.flow');

const TZ = 'Asia/Kolkata';
const STAGE_IDS = FLOOR_STAGES.map((item) => item.id);
const DAY_MS = 24 * 60 * 60 * 1000;

const FINISHED = new Set([SALES_ORDER_STATUSES.DELIVERED, SALES_ORDER_STATUSES.COMPLETED]);
const OPEN = new Set([
  SALES_ORDER_STATUSES.SUBMITTED,
  SALES_ORDER_STATUSES.APPROVED,
  SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
  SALES_ORDER_STATUSES.IN_PRODUCTION,
  SALES_ORDER_STATUSES.READY_FOR_PACKING,
  SALES_ORDER_STATUSES.PACKED,
  SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
  SALES_ORDER_STATUSES.DISPATCHED,
]);

function canSeeMoney(user) {
  return hasPermission(user, 'sales:read') || hasPermission(user, 'accounts:read');
}

function startOfDay(value) {
  const date = new Date(`${value}T00:00:00+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function endOfDay(value) {
  const date = new Date(`${value}T23:59:59.999+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toYmd(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function addDays(ymd, amount) {
  const date = startOfDay(ymd);
  date.setDate(date.getDate() + amount);
  return toYmd(date);
}

function text(value) {
  return String(value ?? '').trim();
}

function parseQuery(query = {}) {
  const today = toYmd(new Date());
  let to = text(query.to || today).slice(0, 10);
  let from = text(query.from || addDays(today, -29)).slice(0, 10);
  if (!startOfDay(from)) from = addDays(today, -29);
  if (!endOfDay(to)) to = today;
  if (from > to) [from, to] = [to, from];
  const orderType = Object.values(ORDER_TYPES).includes(query.orderType) ? query.orderType : '';
  return {
    from,
    to,
    fromDate: startOfDay(from),
    toDate: endOfDay(to),
    filters: {
      stage: STAGE_IDS.includes(query.stage) ? query.stage : '',
      orderType,
      customer: text(query.customer),
      product: text(query.product),
      operator: text(query.operator),
      machine: text(query.machine),
    },
  };
}

function eachDate(from, to) {
  const days = [];
  for (let cursor = from; cursor <= to; cursor = addDays(cursor, 1)) days.push(cursor);
  return days;
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function stageLabel(id) {
  return FLOOR_STAGES.find((item) => item.id === id)?.label || id;
}

function emptyBucket() {
  return { entries: 0, days: new Set(), orders: new Set(), yieldInput: {}, yieldOutput: {}, outputs: {}, wastes: {} };
}

function sameUnitRow(row) {
  return Math.abs(row.input - (row.output + row.waste)) < 1e-6;
}

// kg (rolling) and pcs (printing, cutting) are kept apart; yield only uses rows where input and output share a unit,
// and a mixed-unit group's yield is the average of its per-unit yields so pcs volumes don't drown kg losses.
function addTo(bucket, row) {
  if (row.stage === 'dispatch') return;
  bucket.outputs[row.unit] = (bucket.outputs[row.unit] || 0) + row.output;
  if (row.waste) bucket.wastes[row.wasteUnit] = (bucket.wastes[row.wasteUnit] || 0) + row.waste;
  bucket.entries += 1;
  bucket.days.add(row.date);
  bucket.orders.add(row.orderId);
  if (sameUnitRow(row)) {
    bucket.yieldInput[row.unit] = (bucket.yieldInput[row.unit] || 0) + row.input;
    bucket.yieldOutput[row.unit] = (bucket.yieldOutput[row.unit] || 0) + row.output;
  }
}

function blendedYield(input, output) {
  const rates = Object.keys(input)
    .filter((unit) => input[unit] > 0)
    .map((unit) => output[unit] / input[unit]);
  if (!rates.length) return null;
  return round((rates.reduce((sum, rate) => sum + rate, 0) / rates.length) * 100);
}

function mainUnit(map) {
  const units = Object.keys(map);
  return units.find((unit) => unit !== 'kg') || units[0] || '';
}

function unitText(map) {
  return Object.entries(map)
    .filter(([, value]) => value)
    .map(([unit, value]) => `${round(value).toLocaleString('en-IN')} ${unit}`)
    .join(' · ');
}

function pct(part, whole) {
  if (!(Number(whole) > 0)) return null;
  return round((Number(part) / Number(whole)) * 100);
}

function withRates(row) {
  const outUnit = mainUnit(row.outputs);
  const wasteUnit = mainUnit(row.wastes);
  const output = round(row.outputs[outUnit] || 0);
  const { outputs, wastes, yieldInput, yieldOutput, days, orders, ...rest } = row;
  const activeDays = days.size;
  const yieldPct = blendedYield(yieldInput, yieldOutput);
  return {
    ...rest,
    output,
    outputUnit: outUnit,
    outputText: unitText(outputs),
    waste: round(wastes[wasteUnit] || 0),
    wasteUnit,
    wasteText: unitText(wastes),
    input: round(yieldInput[outUnit] || 0),
    yieldPct,
    wastePct: yieldPct == null ? null : round(100 - yieldPct),
    activeDays,
    orderCount: orders.size,
    perDay: activeDays ? round(output / activeDays) : 0,
  };
}

function deltaPct(current, previous) {
  if (!(Number(previous) > 0)) return null;
  return round(((Number(current) - Number(previous)) / Number(previous)) * 100);
}

async function loadWork(fromDate, toDate) {
  const rows = await SalesOrder.aggregate([
    { $match: { 'items.stageWork.workDate': { $gte: fromDate, $lte: toDate } } },
    { $unwind: '$items' },
    { $unwind: '$items.stageWork' },
    { $match: { 'items.stageWork.workDate': { $gte: fromDate, $lte: toDate } } },
    {
      $project: {
        number: 1,
        status: 1,
        orderType: 1,
        customerId: '$customer',
        customer: '$customerSnapshot.name',
        date: { $dateToString: { format: '%Y-%m-%d', date: '$items.stageWork.workDate', timezone: TZ } },
        stage: '$items.stageWork.stage',
        operator: { $ifNull: ['$items.stageWork.operatorName', 'Unknown'] },
        machine: { $ifNull: ['$items.stageWork.machineName', ''] },
        output: { $ifNull: ['$items.stageWork.outputQty', 0] },
        input: { $ifNull: ['$items.stageWork.inputQty', 0] },
        waste: { $ifNull: ['$items.stageWork.wasteQty', 0] },
        product: '$items.product',
        productCode: '$items.productCode',
        itemUnit: '$items.unit',
      },
    },
  ]);

  return rows.map((row) => {
    const unit = row.stage === 'rolling' ? 'kg' : text(row.itemUnit).toLowerCase() || 'pcs';
    const matching = Math.abs((row.input || 0) - ((row.output || 0) + (row.waste || 0))) < 1e-6;
    return {
      unit,
      wasteUnit: matching ? unit : 'kg',
      orderId: String(row._id),
      number: row.number,
      orderType: row.orderType || ORDER_TYPES.SALES_ORDER,
      customerId: row.customerId ? String(row.customerId) : '',
      customer: row.customer || '',
      status: row.status,
      date: row.date,
      stage: row.stage,
      stageLabel: stageLabel(row.stage),
      operator: text(row.operator) || 'Unknown',
      machine: text(row.machine),
      output: round(row.output),
      input: round(row.input),
      waste: round(row.waste),
      product: row.product || '',
      productCode: row.productCode || row.product || '',
    };
  });
}

function matchesWork(row, filters) {
  if (filters.stage && row.stage !== filters.stage) return false;
  if (filters.orderType && row.orderType !== filters.orderType) return false;
  if (filters.customer && row.customerId !== filters.customer) return false;
  if (filters.product && row.productCode !== filters.product) return false;
  if (filters.operator && row.operator !== filters.operator) return false;
  if (filters.machine && row.machine !== filters.machine) return false;
  return true;
}

// Order-level figures follow the filters that describe an order; operator, machine and stage only narrow floor work.
function matchesOrder(order, filters) {
  if (filters.orderType && (order.orderType || ORDER_TYPES.SALES_ORDER) !== filters.orderType) return false;
  if (filters.customer && String(order.customer?._id || order.customer || '') !== filters.customer) return false;
  if (filters.product && !(order.items || []).some((item) => (item.productCode || item.product) === filters.product)) return false;
  return true;
}

function totalsFrom(rows) {
  const bucket = emptyBucket();
  for (const row of rows) addTo(bucket, row);
  return withRates(bucket);
}

function dispatchedFrom(rows) {
  const units = {};
  for (const row of rows) {
    if (row.stage !== 'dispatch') continue;
    units[row.unit] = (units[row.unit] || 0) + row.output;
  }
  const unit = mainUnit(units);
  return { value: round(units[unit] || 0), unit, text: unitText(units) };
}

function deliveredAt(order) {
  let last = null;
  for (const item of order.items || []) {
    for (const row of item.stageWork || []) {
      if (row.stage !== 'dispatch') continue;
      const at = row.workDate || row.completedAt;
      if (at && (!last || at > last)) last = at;
    }
  }
  return last || order.completedAt || order.updatedAt;
}

function optionList(rows, key, label) {
  const map = new Map();
  for (const row of rows) {
    const id = row[key];
    if (!id) continue;
    const entry = map.get(id) || { id, label: label(row), count: 0 };
    entry.count += 1;
    map.set(id, entry);
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function groupBy(rows, keyOf, seed) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, { ...seed(row), ...emptyBucket(), stages: new Set() });
    const bucket = map.get(key);
    addTo(bucket, row);
    if (row.stage !== 'dispatch') bucket.stages.add(row.stage);
  }
  return [...map.values()]
    .filter((bucket) => bucket.entries > 0)
    .map((bucket) => withRates({ ...bucket, stages: [...bucket.stages] }))
    .sort((a, b) => b.output - a.output);
}

function orderFigures(orders, range, showMoney, today) {
  const { fromDate, toDate } = range;
  const riskUntil = endOfDay(addDays(today, 3)).getTime();
  const todayEnd = endOfDay(today).getTime();
  const statusFlow = SALES_ORDER_STATUS_FLOW.concat(SALES_ORDER_STATUSES.CANCELLED);
  const byStatus = Object.fromEntries(statusFlow.map((id) => [id, { id, count: 0, value: 0 }]));
  const rows = [];
  const figures = { delivered: 0, deliveredValue: 0, onTime: 0, late: 0, leadDays: [], open: 0, openValue: 0, atRisk: 0, overdue: 0, booked: 0, bookedValue: 0 };

  for (const order of orders) {
    const value = Number(order.grandTotal) || 0;
    const bucket = byStatus[order.status] || (byStatus[order.status] = { id: order.status, count: 0, value: 0 });
    bucket.count += 1;
    bucket.value += value;

    const ordered = order.orderDate ? new Date(order.orderDate) : null;
    if (ordered && ordered >= fromDate && ordered <= toDate && order.status !== SALES_ORDER_STATUSES.DRAFT) {
      figures.booked += 1;
      figures.bookedValue += value;
    }

    const doneAt = FINISHED.has(order.status) ? deliveredAt(order) : null;
    const deliveredInRange = Boolean(doneAt && doneAt >= fromDate && doneAt <= toDate);
    let onTime = null;
    if (deliveredInRange) {
      figures.delivered += 1;
      figures.deliveredValue += value;
      if (order.deliveryDate) {
        onTime = doneAt.getTime() <= endOfDay(toYmd(order.deliveryDate)).getTime();
        figures[onTime ? 'onTime' : 'late'] += 1;
      }
      if (ordered) figures.leadDays.push(Math.max(0, (doneAt.getTime() - ordered.getTime()) / DAY_MS));
    }

    const isOpen = OPEN.has(order.status);
    const due = order.deliveryDate ? endOfDay(toYmd(order.deliveryDate)).getTime() : null;
    const overdue = Boolean(isOpen && due && due < todayEnd);
    const atRisk = Boolean(isOpen && due && !overdue && due <= riskUntil);
    if (isOpen) {
      figures.open += 1;
      figures.openValue += value;
    }
    if (overdue) figures.overdue += 1;
    if (atRisk) figures.atRisk += 1;

    if (isOpen || deliveredInRange) {
      rows.push({
        id: String(order._id),
        number: order.number,
        orderType: order.orderType || ORDER_TYPES.SALES_ORDER,
        status: order.status,
        customer: order.customerSnapshot?.name || '',
        grandTotal: showMoney ? round(value) : null,
        orderDate: order.orderDate || null,
        deliveryDate: order.deliveryDate || null,
        completedAt: doneAt,
        onTime,
        overdue,
        atRisk,
        delivered: deliveredInRange,
      });
    }
  }

  const rank = (row) => (row.overdue ? 0 : row.atRisk ? 1 : row.delivered ? 3 : 2);
  rows.sort((a, b) => rank(a) - rank(b) || new Date(a.deliveryDate || 0) - new Date(b.deliveryDate || 0));

  const judged = figures.onTime + figures.late;
  const lead = figures.leadDays;
  return {
    rows,
    byStatus: statusFlow.map((id) => ({ id, count: byStatus[id]?.count || 0, value: showMoney ? round(byStatus[id]?.value || 0) : null })),
    kpis: {
      delivered: figures.delivered,
      deliveredValue: showMoney ? round(figures.deliveredValue) : null,
      onTime: figures.onTime,
      late: figures.late,
      onTimePct: pct(figures.onTime, judged),
      avgLeadDays: lead.length ? round(lead.reduce((sum, days) => sum + days, 0) / lead.length) : null,
      openOrders: figures.open,
      openValue: showMoney ? round(figures.openValue) : null,
      atRisk: figures.atRisk,
      overdue: figures.overdue,
      booked: figures.booked,
      bookedValue: showMoney ? round(figures.bookedValue) : null,
    },
  };
}

async function getAnalytics(user, query) {
  const { from, to, fromDate, toDate, filters } = parseQuery(query);
  const showMoney = canSeeMoney(user);
  const today = toYmd(new Date());
  const span = eachDate(from, to).length;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(from, -span);

  const [allWork, allPrevious, allOrders] = await Promise.all([
    loadWork(fromDate, toDate),
    loadWork(startOfDay(prevFrom), endOfDay(prevTo)),
    SalesOrder.find({ status: { $ne: SALES_ORDER_STATUSES.DRAFT } }).select(
      'number status orderType customer grandTotal customerSnapshot completedAt orderDate deliveryDate updatedAt items.product items.productCode items.stageWork.stage items.stageWork.workDate items.stageWork.completedAt'
    ),
  ]);

  const details = allWork.filter((row) => matchesWork(row, filters));
  const previous = allPrevious.filter((row) => matchesWork(row, filters));
  const orders = allOrders.filter((order) => matchesOrder(order, filters));
  const previousOrders = orderFigures(orders, { fromDate: startOfDay(prevFrom), toDate: endOfDay(prevTo) }, showMoney, prevTo);
  const current = orderFigures(orders, { fromDate, toDate }, showMoney, today);

  const kpis = totalsFrom(details);
  const prevTotals = totalsFrom(previous);
  const dispatched = dispatchedFrom(details);
  const prevDispatched = dispatchedFrom(previous);

  const byDateMap = new Map(eachDate(from, to).map((date) => [date, { date, ...emptyBucket() }]));
  for (const row of details) if (byDateMap.has(row.date)) addTo(byDateMap.get(row.date), row);
  const byStage = STAGE_IDS.filter((id) => id !== 'dispatch' && (!filters.stage || id === filters.stage)).map((id) => {
    const bucket = { id, label: stageLabel(id), ...emptyBucket() };
    for (const row of details) if (row.stage === id) addTo(bucket, row);
    return withRates(bucket);
  });

  const wasteLots = await itemRepo.findAll({ category: INVENTORY_CATEGORIES.WASTE, isActive: true });
  const inventoryWaste = wasteLots.map((lot) => ({
    id: String(lot._id),
    name: lot.name,
    quantity: round(lot.quantity),
    unit: lot.unit,
    kind: lot.kind || 'catalog',
    stage: lot.wipStage || lot.stage?.slug || lot.stage?.name || '',
  }));
  const inventoryUnits = {};
  for (const lot of inventoryWaste) inventoryUnits[lot.unit || 'units'] = (inventoryUnits[lot.unit || 'units'] || 0) + lot.quantity;

  return {
    from,
    to,
    previousFrom: prevFrom,
    previousTo: prevTo,
    filters,
    options: {
      customers: optionList(allWork, 'customerId', (row) => row.customer || 'Unknown'),
      products: optionList(allWork, 'productCode', (row) => (row.product && row.product !== row.productCode ? `${row.productCode} · ${row.product}` : row.productCode)),
      operators: optionList(allWork, 'operator', (row) => row.operator),
      machines: optionList(allWork, 'machine', (row) => row.machine),
    },
    kpis: {
      output: kpis.output,
      outputUnit: kpis.outputUnit,
      outputText: kpis.outputText,
      waste: kpis.waste,
      wasteText: kpis.wasteText,
      wastePct: kpis.wastePct,
      yieldPct: kpis.yieldPct,
      entries: kpis.entries,
      activeDays: kpis.activeDays,
      perDay: kpis.perDay,
      operators: new Set(details.filter((row) => row.stage !== 'dispatch').map((row) => row.operator)).size,
      ordersWorked: kpis.orderCount,
      dispatched: dispatched.value,
      dispatchedUnit: dispatched.unit,
      dispatchedText: dispatched.text,
      ...current.kpis,
      previous: {
        outputDelta: deltaPct(kpis.output, prevTotals.output),
        wastePctDelta: kpis.wastePct != null && prevTotals.wastePct != null ? round(kpis.wastePct - prevTotals.wastePct) : null,
        yieldDelta: kpis.yieldPct != null && prevTotals.yieldPct != null ? round(kpis.yieldPct - prevTotals.yieldPct) : null,
        dispatchedDelta: deltaPct(dispatched.value, prevDispatched.value),
        deliveredDelta: deltaPct(current.kpis.delivered, previousOrders.kpis.delivered),
        bookedDelta: deltaPct(current.kpis.booked, previousOrders.kpis.booked),
      },
    },
    byDate: [...byDateMap.values()].map(withRates),
    byStage,
    byOperator: groupBy(details, (row) => (row.stage === 'dispatch' ? '' : row.operator), (row) => ({ name: row.operator })),
    byMachine: groupBy(details, (row) => row.machine, (row) => ({ name: row.machine })),
    byProduct: groupBy(details, (row) => row.productCode, (row) => ({ code: row.productCode, name: row.product || row.productCode })),
    byCustomer: groupBy(details, (row) => row.customerId, (row) => ({ id: row.customerId, name: row.customer || 'Unknown' })),
    byStatus: current.byStatus,
    orders: current.rows,
    waste: {
      byStage: byStage.map((row) => ({ id: row.id, label: row.label, waste: row.waste, wasteText: row.wasteText, wastePct: row.wastePct })),
      inventory: inventoryWaste,
      inventoryText: unitText(inventoryUnits),
    },
    details,
  };
}

module.exports = { getAnalytics };
