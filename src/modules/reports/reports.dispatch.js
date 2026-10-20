const ApiError = require('../../utils/ApiError');
const { hasPermission } = require('../../utils/permissions');
const { businessYmd, endOfBusinessDay } = require('../../utils/businessTime');
const { SALES_ORDER_STATUSES } = require('../../config/constants');
const SalesOrder = require('../salesOrder/salesOrder.model');
const { activeStage } = require('../production/production.flow');
const { customerOf, STAGE_LABEL } = require('./reports.production');
const { parseRange, monthsOf, monthOf, inRange, DAY } = require('./reports.range');

const DELIVERED = [SALES_ORDER_STATUSES.DELIVERED, SALES_ORDER_STATUSES.COMPLETED];
const NOT_OPEN = [SALES_ORDER_STATUSES.DRAFT, SALES_ORDER_STATUSES.CANCELLED, ...DELIVERED];
const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pct = (part, whole) => (whole > 0 ? r1((part / whole) * 100) : null);
const avg = (list) => (list.length ? r1(list.reduce((s, v) => s + v, 0) / list.length) : null);

function canSee(user) {
  return ['dispatch:read', 'production:read', 'sales:read'].some((key) => hasPermission(user, key));
}

function unitsText(map) {
  return Object.entries(map)
    .filter(([, q]) => q > 0)
    .map(([u, q]) => `${r2(q).toLocaleString('en-IN')} ${u}`)
    .join(' · ');
}

// When the last goods of the order left: the latest dispatch entry.
function lastDispatch(order) {
  let last = null;
  for (const item of order.items || []) {
    for (const w of item.stageWork || []) {
      if (w.stage !== 'dispatch') continue;
      const at = new Date(w.workDate || w.completedAt);
      if (!last || at > last) last = at;
    }
  }
  return last || (order.completedAt ? new Date(order.completedAt) : null);
}

// Days after the promised day (0 = on time). The promise is kept if it left by
// the end of the delivery day.
function daysLate(promised, actual) {
  if (!promised || !actual) return null;
  const due = endOfBusinessDay(promised).getTime();
  return actual.getTime() <= due ? 0 : Math.ceil((actual.getTime() - due) / DAY);
}

async function dispatchReport(user, query) {
  if (!canSee(user)) throw new ApiError(403, 'You cannot see the dispatch reports');
  const range = parseRange(query);
  const now = new Date();
  const [shipped, open] = await Promise.all([
    SalesOrder.find({ status: { $ne: SALES_ORDER_STATUSES.CANCELLED }, 'items.stageWork': { $elemMatch: { stage: 'dispatch', workDate: { $gte: range.previous.start, $lte: range.end } } } })
      .select('number orderType status orderDate deliveryDate completedAt customer customerSnapshot items')
      .lean(),
    SalesOrder.find({ status: { $nin: NOT_OPEN } })
      .select('number orderType status orderDate deliveryDate customer customerSnapshot items.product items.productCode items.quantity items.unit items.productionRoute items.stageWork items.stagePickup items.manufacturing')
      .lean(),
  ]);

  // ---- every dispatch entry in the period (the dispatch register)
  const entries = [];
  const byDay = new Map();
  for (const order of shipped) {
    for (const item of order.items || []) {
      for (const w of item.stageWork || []) {
        if (w.stage !== 'dispatch' || !inRange(w.workDate, range)) continue;
        const unit = item.unit || 'pcs';
        entries.push({
          id: String(w._id),
          date: w.workDate,
          orderId: String(order._id),
          number: order.number,
          customer: customerOf(user, order),
          product: item.product || item.productCode || '',
          quantity: r2(w.outputQty),
          unit,
          vehicle: w.vehicleNumber || '',
          partner: w.deliveryPartner || '',
          handover: w.handoverPerson || '',
          by: w.operatorName || '',
        });
        const day = businessYmd(w.workDate);
        const d = byDay.get(day) || { day, entries: 0, orders: new Set(), units: {}, vehicles: new Set() };
        d.entries += 1;
        d.orders.add(String(order._id));
        d.units[unit] = (d.units[unit] || 0) + (Number(w.outputQty) || 0);
        if (w.vehicleNumber) d.vehicles.add(w.vehicleNumber.toUpperCase());
        byDay.set(day, d);
      }
    }
  }
  entries.sort((a, b) => new Date(b.date) - new Date(a.date));

  // ---- orders fully delivered in the period: on time or late
  const delivered = (inPeriod) =>
    shipped
      .filter((o) => DELIVERED.includes(o.status))
      .map((o) => ({ order: o, at: lastDispatch(o) }))
      .filter((x) => x.at && inRange(x.at, inPeriod))
      .map(({ order, at }) => ({
        id: String(order._id),
        number: order.number,
        orderType: order.orderType,
        customer: customerOf(user, order),
        customerKey: String(order.customer || order.customerSnapshot?.code || ''),
        orderDate: order.orderDate,
        promised: order.deliveryDate,
        deliveredAt: at,
        daysLate: daysLate(order.deliveryDate, at),
        leadDays: order.orderDate ? r1((at - new Date(order.orderDate)) / DAY) : null,
      }));
  const done = delivered(range).sort((a, b) => new Date(b.deliveredAt) - new Date(a.deliveredAt));
  const previousDone = delivered(range.previous);
  const judged = done.filter((d) => d.daysLate != null);
  const onTime = judged.filter((d) => d.daysLate === 0).length;
  const prevJudged = previousDone.filter((d) => d.daysLate != null);
  const prevOnTime = prevJudged.filter((d) => d.daysLate === 0).length;

  const monthly = new Map(monthsOf(range.from, range.to).map((m) => [m, { month: m, onTime: 0, late: 0, noDate: 0 }]));
  for (const d of done) {
    const row = monthly.get(monthOf(d.deliveredAt));
    if (!row) continue;
    if (d.daysLate == null) row.noDate += 1;
    else if (d.daysLate === 0) row.onTime += 1;
    else row.late += 1;
  }
  const byCustomer = new Map();
  for (const d of done) {
    const c = byCustomer.get(d.customerKey) || { key: d.customerKey, customer: d.customer, delivered: 0, onTime: 0, late: 0, lateDays: [], leadDays: [] };
    c.delivered += 1;
    if (d.daysLate === 0) c.onTime += 1;
    if (d.daysLate > 0) {
      c.late += 1;
      c.lateDays.push(d.daysLate);
    }
    if (d.leadDays != null) c.leadDays.push(d.leadDays);
    byCustomer.set(d.customerKey, c);
  }

  // ---- open orders: late now, and due in the next 7 days
  const openRows = open
    .filter((o) => o.deliveryDate)
    .map((o) => {
      const due = endOfBusinessDay(o.deliveryDate).getTime();
      const lines = (o.items || []).map(activeStage);
      return {
        id: String(o._id),
        number: o.number,
        orderType: o.orderType,
        status: o.status,
        customer: customerOf(user, o),
        promised: o.deliveryDate,
        daysLate: due < now.getTime() ? Math.ceil((now.getTime() - due) / DAY) : 0,
        dueInDays: due >= now.getTime() ? Math.floor((due - now.getTime()) / DAY) : null,
        stageNow: [...new Set(lines.filter((s) => s !== 'completed'))].map((s) => STAGE_LABEL[s] || s).join(', ') || 'Completed',
      };
    });
  const lateNow = openRows.filter((o) => o.daysLate > 0).sort((a, b) => b.daysLate - a.daysLate);
  const dueSoon = openRows.filter((o) => o.dueInDays != null && o.dueInDays <= 7).sort((a, b) => a.dueInDays - b.dueInDays);

  const dispatchedUnits = {};
  for (const e of entries) dispatchedUnits[e.unit] = (dispatchedUnits[e.unit] || 0) + e.quantity;
  const lateDays = judged.filter((d) => d.daysLate > 0).map((d) => d.daysLate);
  const onTimePct = pct(onTime, judged.length);
  const prevPct = pct(prevOnTime, prevJudged.length);

  return {
    from: range.from,
    to: range.to,
    previous: { from: range.previous.from, to: range.previous.to },
    generatedAt: now,
    kpis: {
      delivered: done.length,
      onTime,
      late: judged.length - onTime,
      onTimePct,
      onTimeChange: onTimePct != null && prevPct != null ? r1(onTimePct - prevPct) : null,
      avgDaysLate: avg(lateDays),
      avgLeadDays: avg(done.filter((d) => d.leadDays != null).map((d) => d.leadDays)),
      dispatchEntries: entries.length,
      dispatchedText: unitsText(dispatchedUnits),
      dispatchDays: byDay.size,
      lateNow: lateNow.length,
      dueSoon: dueSoon.length,
    },
    monthly: [...monthly.values()],
    byCustomer: [...byCustomer.values()]
      .map((c) => ({ key: c.key, customer: c.customer, delivered: c.delivered, onTime: c.onTime, late: c.late, onTimePct: pct(c.onTime, c.onTime + c.late), avgDaysLate: avg(c.lateDays), avgLeadDays: avg(c.leadDays) }))
      .sort((a, b) => b.delivered - a.delivered),
    byDay: [...byDay.values()].map((d) => ({ day: d.day, entries: d.entries, orders: d.orders.size, quantityText: unitsText(d.units), vehicles: [...d.vehicles].join(', ') })).sort((a, b) => b.day.localeCompare(a.day)),
    delivered: done,
    lateNow,
    dueSoon,
    entries,
  };
}

module.exports = { dispatchReport };
