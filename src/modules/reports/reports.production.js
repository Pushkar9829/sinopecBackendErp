const ApiError = require('../../utils/ApiError');
const { hasPermission, isSuperAdmin } = require('../../utils/permissions');
const { SALES_ORDER_STATUSES } = require('../../config/constants');
const SalesOrder = require('../salesOrder/salesOrder.model');
const { routeStages, previousStage, stageStats, activeStage } = require('../production/production.flow');
const { parseRange, monthsOf, monthOf, inRange, DAY } = require('./reports.range');

const STAGE_LABEL = { rolling: 'Rolling', printing: 'Printing', cutting: 'Cutting', dispatch: 'Dispatch' };
const MAKE_STAGES = ['rolling', 'printing', 'cutting'];
const OPEN_FOR_FLOOR = [
  SALES_ORDER_STATUSES.APPROVED,
  SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
  SALES_ORDER_STATUSES.IN_PRODUCTION,
  SALES_ORDER_STATUSES.READY_FOR_PACKING,
  SALES_ORDER_STATUSES.PACKED,
  SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
  SALES_ORDER_STATUSES.DISPATCHED,
];
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const days = (from, to) => (from && to ? Math.max(0, (new Date(to) - new Date(from)) / DAY) : null);
const avg = (list) => (list.length ? r1(list.reduce((s, v) => s + v, 0) / list.length) : null);
const pct = (part, whole) => (whole > 0 ? r1((part / whole) * 100) : null);

function canSee(user) {
  return hasPermission(user, 'production:read');
}

// Only the owner sees customer names on the floor reports; everyone else sees codes.
const customerOf = (user, order) => (isSuperAdmin(user) ? order.customerSnapshot?.companyName || order.customerSnapshot?.name || '' : order.customerSnapshot?.code || '');

function unitsText(map) {
  return Object.entries(map)
    .filter(([, q]) => q > 0)
    .map(([u, q]) => `${r2(q).toLocaleString('en-IN')} ${u}`)
    .join(' · ');
}

function workOf(item, stage) {
  return (item.stageWork || []).filter((w) => w.stage === stage);
}
const firstAt = (rows) => rows.reduce((m, w) => (!m || new Date(w.workDate || w.completedAt) < m ? new Date(w.workDate || w.completedAt) : m), null);
const lastAt = (rows) => rows.reduce((m, w) => (!m || new Date(w.completedAt || w.workDate) > m ? new Date(w.completedAt || w.workDate) : m), null);

async function productionReport(user, query) {
  if (!canSee(user)) throw new ApiError(403, 'You cannot see the production reports');
  const range = parseRange(query);
  const now = new Date();
  const [worked, open] = await Promise.all([
    SalesOrder.find({ status: { $ne: SALES_ORDER_STATUSES.CANCELLED }, 'items.stageWork.workDate': { $gte: range.previous.start, $lte: range.end } })
      .select('number orderType status approvedAt orderDate deliveryDate customerSnapshot items')
      .lean(),
    SalesOrder.find({ status: { $in: OPEN_FOR_FLOOR } })
      .select('number orderType status approvedAt orderDate deliveryDate customerSnapshot items')
      .lean(),
  ]);

  // ---- output and waste, by month x stage and by material
  const months = monthsOf(range.from, range.to);
  const blank = () => ({ output: 0, waste: 0, units: {}, entries: 0 });
  const monthStage = new Map(months.map((m) => [m, Object.fromEntries(MAKE_STAGES.map((s) => [s, blank()]))]));
  const byMaterial = new Map();
  const byStage = Object.fromEntries(MAKE_STAGES.map((s) => [s, { ...blank(), prevOutput: 0, prevWaste: 0 }]));
  for (const order of worked) {
    for (const item of order.items || []) {
      for (const w of item.stageWork || []) {
        if (!MAKE_STAGES.includes(w.stage)) continue;
        const out = Number(w.outputQty) || 0;
        const waste = Number(w.wasteQty) || 0;
        if (inRange(w.workDate, range.previous)) {
          byStage[w.stage].prevOutput += out;
          byStage[w.stage].prevWaste += waste;
          continue;
        }
        if (!inRange(w.workDate, range)) continue;
        const unit = w.stage === 'rolling' ? 'kg' : item.unit || 'pcs';
        const cell = monthStage.get(monthOf(w.workDate))?.[w.stage];
        if (cell) {
          cell.output += out;
          cell.waste += waste;
          cell.entries += 1;
        }
        const s = byStage[w.stage];
        s.output += out;
        s.waste += waste;
        s.entries += 1;
        s.units[unit] = (s.units[unit] || 0) + out;
        // Material is used up at rolling (kg); later stages count pieces.
        if (w.stage !== 'rolling') continue;
        const material = item.material || item.manufacturing?.material || 'Not set';
        const m = byMaterial.get(material) || { material, output: 0, waste: 0, entries: 0, orders: new Set(), units: {} };
        m.output += out;
        m.waste += waste;
        m.entries += 1;
        m.orders.add(String(order._id));
        m.units[unit] = (m.units[unit] || 0) + out;
        byMaterial.set(material, m);
      }
    }
  }
  const wasteTrend = months.map((month) => {
    const row = { month };
    for (const s of MAKE_STAGES) {
      const c = monthStage.get(month)[s];
      row[`${s}WastePct`] = pct(c.waste, c.output + c.waste);
      row[`${s}Output`] = r2(c.output);
      row[`${s}Waste`] = r2(c.waste);
    }
    return row;
  });
  const stageRows = MAKE_STAGES.map((s) => {
    const x = byStage[s];
    const wastePct = pct(x.waste, x.output + x.waste);
    const prevPct = pct(x.prevWaste, x.prevOutput + x.prevWaste);
    return { stage: s, label: STAGE_LABEL[s], entries: x.entries, outputText: unitsText(x.units), output: r2(x.output), waste: r2(x.waste), wastePct, wastePctChange: wastePct != null && prevPct != null ? r1(wastePct - prevPct) : null };
  });
  const materials = [...byMaterial.values()]
    .map((m) => ({ material: m.material, outputText: unitsText(m.units), output: r2(m.output), waste: r2(m.waste), wastePct: pct(m.waste, m.output + m.waste), entries: m.entries, orders: m.orders.size }))
    .sort((a, b) => b.output - a.output);

  // ---- how long each stage takes, for stages finished in the period
  const timing = Object.fromEntries([...MAKE_STAGES, 'dispatch'].map((s) => [s, { waits: [], works: [] }]));
  const approvalToStart = [];
  const approvalToDispatch = [];
  for (const order of worked) {
    for (const item of order.items || []) {
      const stages = routeStages(item.productionRoute);
      let lineStart = null;
      for (const stage of stages) {
        const rows = workOf(item, stage);
        if (!rows.length || !stageStats(item, stage).done) continue;
        const end = lastAt(rows);
        if (!inRange(end, range)) continue;
        const start = firstAt(rows);
        const prev = previousStage(item.productionRoute, stage);
        const readyAt = prev ? lastAt(workOf(item, prev)) : order.approvedAt || order.orderDate;
        const wait = days(readyAt, start);
        if (wait != null && timing[stage]) timing[stage].waits.push(wait);
        if (timing[stage]) timing[stage].works.push(days(start, end));
        if (!lineStart || start < lineStart) lineStart = start;
        if (stage === 'dispatch' && order.approvedAt) approvalToDispatch.push(days(order.approvedAt, end));
      }
      if (lineStart && order.approvedAt && inRange(lineStart, range)) approvalToStart.push(days(order.approvedAt, lineStart));
    }
  }
  const stageTimes = [...MAKE_STAGES, 'dispatch'].map((s) => ({
    stage: s,
    label: STAGE_LABEL[s],
    lines: timing[s].works.length,
    avgWaitDays: avg(timing[s].waits),
    avgWorkDays: avg(timing[s].works),
    avgTotalDays: timing[s].works.length ? r1((avg(timing[s].waits) || 0) + (avg(timing[s].works) || 0)) : null,
  }));

  // ---- work in progress now: where each open line is, and how long it has waited
  const waiting = [];
  for (const order of open) {
    for (const item of order.items || []) {
      const stage = activeStage(item);
      if (stage === 'completed') continue;
      const stats = stageStats(item, stage);
      const here = workOf(item, stage);
      const prev = previousStage(item.productionRoute, stage);
      const since = here.length ? lastAt(here) : prev ? lastAt(workOf(item, prev)) : order.approvedAt || order.orderDate;
      waiting.push({
        id: `${order._id}:${item._id}`,
        orderId: String(order._id),
        number: order.number,
        orderType: order.orderType,
        customer: customerOf(user, order),
        product: item.product || item.productCode || '',
        stage,
        stageLabel: STAGE_LABEL[stage] || stage,
        started: here.length > 0,
        remaining: r2(stats.remaining),
        unit: stats.unit,
        target: r2(stats.target),
        done: r2(stats.output),
        since,
        daysWaiting: since ? r1(days(since, now)) : null,
        deliveryDate: order.deliveryDate || null,
        late: Boolean(order.deliveryDate && new Date(order.deliveryDate).getTime() < now.getTime() - DAY / 2),
      });
    }
  }
  waiting.sort((a, b) => (b.daysWaiting || 0) - (a.daysWaiting || 0));
  const wip = [...MAKE_STAGES, 'dispatch'].map((s) => {
    const rows = waiting.filter((w) => w.stage === s);
    const units = {};
    for (const w of rows) units[w.unit] = (units[w.unit] || 0) + w.remaining;
    return {
      stage: s,
      label: STAGE_LABEL[s],
      lines: rows.length,
      orders: new Set(rows.map((w) => w.orderId)).size,
      notStarted: rows.filter((w) => !w.started).length,
      remainingText: unitsText(units),
      oldestDays: rows.length ? Math.max(...rows.map((w) => w.daysWaiting || 0)) : null,
      avgWaitingDays: avg(rows.map((w) => w.daysWaiting || 0)),
      late: rows.filter((w) => w.late).length,
    };
  });

  const slowest = stageTimes.filter((s) => s.avgTotalDays != null).sort((a, b) => b.avgTotalDays - a.avgTotalDays)[0];
  const mostStuck = wip.filter((w) => w.lines).sort((a, b) => b.lines - a.lines)[0];

  return {
    from: range.from,
    to: range.to,
    previous: { from: range.previous.from, to: range.previous.to },
    generatedAt: now,
    kpis: {
      entries: stageRows.reduce((s, r) => s + r.entries, 0),
      // Units differ by stage (kg at rolling, pieces later), so waste % is per stage.
      wastePctByStage: Object.fromEntries(stageRows.map((r) => [r.stage, r.wastePct])),
      approvalToStartDays: avg(approvalToStart),
      approvalToDispatchDays: avg(approvalToDispatch),
      slowestStage: slowest ? slowest.label : null,
      slowestDays: slowest ? slowest.avgTotalDays : null,
      linesInProgress: waiting.length,
      linesLate: waiting.filter((w) => w.late).length,
      mostStuckStage: mostStuck ? mostStuck.label : null,
      mostStuckLines: mostStuck ? mostStuck.lines : 0,
      waitingOver7Days: waiting.filter((w) => (w.daysWaiting || 0) > 7).length,
    },
    stages: stageRows,
    wasteTrend,
    materials,
    stageTimes,
    wip,
    waiting,
  };
}

module.exports = { productionReport, STAGE_LABEL, customerOf };
