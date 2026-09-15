const {
  INVENTORY_CATEGORIES,
  PRODUCTION_SHIFTS,
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

function parseRange(query = {}) {
  const today = toYmd(new Date());
  let to = String(query.to || today).slice(0, 10);
  let from = String(query.from || addDays(today, -13)).slice(0, 10);
  if (!startOfDay(from)) from = addDays(today, -13);
  if (!endOfDay(to)) to = today;
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  const stage = STAGE_IDS.includes(query.stage) ? query.stage : '';
  return { from, to, stage, fromDate: startOfDay(from), toDate: endOfDay(to) };
}

function eachDate(from, to) {
  const days = [];
  let cursor = from;
  while (cursor <= to) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return days;
}

function round(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function stageLabel(id) {
  return FLOOR_STAGES.find((item) => item.id === id)?.label || id;
}

function shiftLabel(id) {
  return PRODUCTION_SHIFTS.find((item) => item.id === id)?.label || id || '—';
}

function emptyBucket() {
  return { output: 0, waste: 0, input: 0, shifts: 0 };
}

function addTo(bucket, row) {
  bucket.output += row.output;
  bucket.waste += row.waste;
  bucket.input += row.input;
  bucket.shifts += 1;
}

function yieldPct(output, input) {
  if (!(Number(input) > 0)) return 0;
  return round((Number(output) / Number(input)) * 100);
}

function perShift(output, shifts) {
  if (!(Number(shifts) > 0)) return 0;
  return round(Number(output) / Number(shifts));
}

function withRates(row) {
  return {
    ...row,
    yieldPct: yieldPct(row.output, row.input),
    perShift: perShift(row.output, row.shifts),
  };
}

function deltaPct(current, previous) {
  if (!(Number(previous) > 0)) return null;
  return round(((Number(current) - Number(previous)) / Number(previous)) * 100);
}

async function loadWork(fromDate, toDate, stage) {
  const workMatch = {
    'items.stageWork.workDate': { $gte: fromDate, $lte: toDate },
  };
  if (stage) workMatch['items.stageWork.stage'] = stage;

  const workRows = await SalesOrder.aggregate([
    { $unwind: '$items' },
    { $unwind: '$items.stageWork' },
    { $match: workMatch },
    {
      $project: {
        number: 1,
        status: 1,
        grandTotal: 1,
        customer: '$customerSnapshot.name',
        date: {
          $dateToString: { format: '%Y-%m-%d', date: '$items.stageWork.workDate', timezone: TZ },
        },
        stage: '$items.stageWork.stage',
        shift: { $ifNull: ['$items.stageWork.shift', 'morning'] },
        operator: { $ifNull: ['$items.stageWork.operatorName', 'Unknown'] },
        machine: { $ifNull: ['$items.stageWork.machineName', ''] },
        output: { $ifNull: ['$items.stageWork.outputQty', 0] },
        input: { $ifNull: ['$items.stageWork.inputQty', 0] },
        waste: { $ifNull: ['$items.stageWork.wasteQty', 0] },
        product: '$items.product',
        productCode: '$items.productCode',
      },
    },
  ]);

  return workRows.map((row) => ({
    orderId: String(row._id),
    number: row.number,
    customer: row.customer || '',
    status: row.status,
    date: row.date,
    stage: row.stage,
    stageLabel: stageLabel(row.stage),
    shift: row.shift,
    shiftLabel: shiftLabel(row.shift),
    operator: row.operator,
    machine: String(row.machine || '').trim(),
    output: round(row.output),
    input: round(row.input),
    waste: round(row.waste),
    product: row.product || '',
    productCode: row.productCode || '',
  }));
}

function totalsFrom(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.output += row.output;
      acc.waste += row.waste;
      acc.input += row.input;
      acc.shifts += 1;
      return acc;
    },
    { output: 0, waste: 0, input: 0, shifts: 0 }
  );
}

function roundBucket(row) {
  return {
    ...row,
    output: round(row.output),
    waste: round(row.waste),
    input: round(row.input),
  };
}

async function getAnalytics(user, query) {
  const { from, to, stage, fromDate, toDate } = parseRange(query);
  const showMoney = canSeeMoney(user);
  const today = toYmd(new Date());
  const span = eachDate(from, to).length;
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(from, -span);

  const [details, previousDetails, orders] = await Promise.all([
    loadWork(fromDate, toDate, stage),
    loadWork(startOfDay(prevFrom), endOfDay(prevTo), stage),
    SalesOrder.find({}).select(
      'number status grandTotal customerSnapshot completedAt orderDate deliveryDate updatedAt'
    ),
  ]);

  const byDateMap = new Map(eachDate(from, to).map((date) => [date, { date, ...emptyBucket() }]));
  const byStageMap = new Map(
    STAGE_IDS.filter((id) => !stage || id === stage).map((id) => [id, { id, label: stageLabel(id), ...emptyBucket() }])
  );
  const byShiftMap = new Map(PRODUCTION_SHIFTS.map((item) => [item.id, { id: item.id, label: item.label, ...emptyBucket() }]));
  const byOperatorMap = new Map();
  const byProductMap = new Map();
  const byMachineMap = new Map();
  const orderIds = new Set();

  for (const row of details) {
    orderIds.add(row.orderId);
    addTo(byDateMap.get(row.date) || (byDateMap.set(row.date, { date: row.date, ...emptyBucket() }).get(row.date)), row);
    if (byStageMap.has(row.stage)) addTo(byStageMap.get(row.stage), row);
    if (byShiftMap.has(row.shift)) addTo(byShiftMap.get(row.shift), row);
    if (!byOperatorMap.has(row.operator)) {
      byOperatorMap.set(row.operator, { name: row.operator, ...emptyBucket(), stages: new Set() });
    }
    const op = byOperatorMap.get(row.operator);
    addTo(op, row);
    op.stages.add(row.stage);

    const productKey = row.productCode || row.product || 'Unknown';
    if (!byProductMap.has(productKey)) {
      byProductMap.set(productKey, {
        code: row.productCode || productKey,
        name: row.product || productKey,
        ...emptyBucket(),
      });
    }
    addTo(byProductMap.get(productKey), row);

    if (row.machine) {
      if (!byMachineMap.has(row.machine)) {
        byMachineMap.set(row.machine, { name: row.machine, ...emptyBucket(), stages: new Set() });
      }
      const machine = byMachineMap.get(row.machine);
      addTo(machine, row);
      machine.stages.add(row.stage);
    }
  }

  const kpis = totalsFrom(details);
  const previousTotals = totalsFrom(previousDetails);
  const prevFromDate = startOfDay(prevFrom);
  const prevToDate = endOfDay(prevTo);
  const riskUntil = endOfDay(addDays(today, 3));
  const finishedStatuses = new Set([SALES_ORDER_STATUSES.DELIVERED, SALES_ORDER_STATUSES.COMPLETED]);
  const openStatuses = new Set([
    SALES_ORDER_STATUSES.IN_PRODUCTION,
    SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
    SALES_ORDER_STATUSES.DISPATCHED,
  ]);

  const statusFlow = SALES_ORDER_STATUS_FLOW.concat(SALES_ORDER_STATUSES.CANCELLED);
  const byStatusMap = Object.fromEntries(statusFlow.map((id) => [id, { id, count: 0, value: 0 }]));
  const orderRows = [];
  let completedCount = 0;
  let completedValue = 0;
  let previousCompleted = 0;
  let onTime = 0;
  let late = 0;
  let atRisk = 0;
  const tableStatuses = new Set([
    SALES_ORDER_STATUSES.COMPLETED,
    SALES_ORDER_STATUSES.DELIVERED,
    SALES_ORDER_STATUSES.IN_PRODUCTION,
    SALES_ORDER_STATUSES.DISPATCHED,
    SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
  ]);

  for (const order of orders) {
    const bucket = byStatusMap[order.status] || (byStatusMap[order.status] = { id: order.status, count: 0, value: 0 });
    bucket.count += 1;
    bucket.value += Number(order.grandTotal) || 0;
    const doneAt = order.completedAt || (finishedStatuses.has(order.status) ? order.updatedAt : null);
    const completedInRange =
      finishedStatuses.has(order.status) && doneAt && doneAt >= fromDate && doneAt <= toDate;
    const completedPrev =
      finishedStatuses.has(order.status) && doneAt && doneAt >= prevFromDate && doneAt <= prevToDate;
    let onTimeFlag = null;
    if (completedInRange) {
      completedCount += 1;
      completedValue += Number(order.grandTotal) || 0;
      if (order.deliveryDate && doneAt) {
        onTimeFlag = doneAt.getTime() <= endOfDay(toYmd(order.deliveryDate)).getTime();
        if (onTimeFlag) onTime += 1;
        else late += 1;
      }
    }
    if (completedPrev) previousCompleted += 1;
    const due = order.deliveryDate ? endOfDay(toYmd(order.deliveryDate)) : null;
    const risk = Boolean(openStatuses.has(order.status) && due && due.getTime() <= riskUntil.getTime());
    if (risk) atRisk += 1;
    if (tableStatuses.has(order.status) || risk) {
      orderRows.push({
        id: String(order._id),
        number: order.number,
        status: order.status,
        customer: order.customerSnapshot?.name || '',
        grandTotal: showMoney ? round(order.grandTotal) : null,
        completedAt: doneAt,
        deliveryDate: order.deliveryDate || null,
        onTime: onTimeFlag,
        atRisk: risk,
        inRange: Boolean(completedInRange || orderIds.has(String(order._id))),
      });
    }
  }

  const wasteLots = await itemRepo.findAll({ category: INVENTORY_CATEGORIES.WASTE, isActive: true });
  const inventoryWaste = wasteLots.map((lot) => ({
    id: String(lot._id),
    name: lot.name,
    quantity: round(lot.quantity),
    unit: lot.unit,
    kind: lot.kind || 'catalog',
    stage: lot.wipStage || lot.stage?.slug || lot.stage?.name || '',
  }));

  return {
    from,
    to,
    previousFrom: prevFrom,
    previousTo: prevTo,
    stage: stage || 'all',
    kpis: {
      output: round(kpis.output),
      waste: round(kpis.waste),
      input: round(kpis.input),
      shifts: kpis.shifts,
      operators: byOperatorMap.size,
      orders: orderIds.size,
      completed: completedCount,
      wastePct: kpis.output + kpis.waste > 0 ? round((kpis.waste / (kpis.output + kpis.waste)) * 100) : 0,
      yieldPct: yieldPct(kpis.output, kpis.input),
      perShift: perShift(kpis.output, kpis.shifts),
      onTime,
      late,
      atRisk,
      completedValue: showMoney ? round(completedValue) : null,
      previous: {
        output: round(previousTotals.output),
        waste: round(previousTotals.waste),
        completed: previousCompleted,
        yieldPct: yieldPct(previousTotals.output, previousTotals.input),
        outputDelta: deltaPct(kpis.output, previousTotals.output),
        wasteDelta: deltaPct(kpis.waste, previousTotals.waste),
        completedDelta: deltaPct(completedCount, previousCompleted),
      },
    },
    byDate: [...byDateMap.values()].map((row) => withRates(roundBucket(row))),
    byStage: [...byStageMap.values()].map((row) => withRates(roundBucket(row))),
    byOperator: [...byOperatorMap.values()]
      .map((row) => withRates(roundBucket({ ...row, stages: [...row.stages] })))
      .sort((a, b) => b.output - a.output),
    byShift: [...byShiftMap.values()].map((row) => withRates(roundBucket(row))),
    byProduct: [...byProductMap.values()]
      .map((row) => withRates(roundBucket(row)))
      .sort((a, b) => b.output - a.output),
    byMachine: [...byMachineMap.values()]
      .map((row) => withRates(roundBucket({ ...row, stages: [...row.stages] })))
      .sort((a, b) => b.output - a.output),
    byStatus: statusFlow.map((id) => ({
      id,
      count: byStatusMap[id]?.count || 0,
      value: showMoney ? round(byStatusMap[id]?.value || 0) : null,
    })),
    orders: orderRows.sort((a, b) => {
      if (a.atRisk !== b.atRisk) return a.atRisk ? -1 : 1;
      if (a.status !== b.status) {
        const rank = { completed: 0, delivered: 0, dispatched: 1, ready_for_dispatch: 2, in_production: 3 };
        return (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
      }
      return new Date(b.completedAt || 0) - new Date(a.completedAt || 0);
    }),
    waste: {
      byStage: [...byStageMap.values()].map((row) => ({
        id: row.id,
        label: row.label,
        waste: round(row.waste),
        output: round(row.output),
      })),
      inventory: inventoryWaste,
      inventoryTotal: round(inventoryWaste.reduce((sum, lot) => sum + lot.quantity, 0)),
    },
    details,
  };
}

module.exports = { getAnalytics };
