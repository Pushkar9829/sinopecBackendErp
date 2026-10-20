const ApiError = require('../../utils/ApiError');
const { hasPermission } = require('../../utils/permissions');
const { SALES_ORDER_STATUSES, SALES_ORDER_STATUS_FLOW, ORDER_TYPES } = require('../../config/constants');
const SalesOrder = require('../salesOrder/salesOrder.model');
const { parseRange, monthsOf, monthOf, inRange, deltaPct, money, DAY } = require('./reports.range');

// A customer counts as "stopped ordering" after this many days without an order.
const LAPSED_DAYS = 60;
const LAPSED_LOOKBACK_DAYS = 365;
const OPEN_STATUSES = SALES_ORDER_STATUS_FLOW.filter((s) => ![SALES_ORDER_STATUSES.DRAFT, SALES_ORDER_STATUSES.DELIVERED, SALES_ORDER_STATUSES.COMPLETED].includes(s));
const STATUS_LABEL = {
  submitted: 'Waiting for approval',
  approved: 'Approved',
  production_planned: 'Production planned',
  in_production: 'In production',
  ready_for_packing: 'Ready for packing',
  packed: 'Packed',
  ready_for_dispatch: 'Ready for dispatch',
  dispatched: 'Dispatched, not delivered',
};

function canSee(user) {
  return hasPermission(user, 'sales:read');
}

const nameOf = (order) => order.customerSnapshot?.companyName || order.customerSnapshot?.name || 'Unknown';
const customerKey = (order) => String(order.customer || order.customerSnapshot?.code || nameOf(order));
const isJobWork = (order) => order.orderType === ORDER_TYPES.JOB_WORK;

// Quantities in mixed units, e.g. "12,000 pcs · 350 kg".
function unitText(map) {
  return Object.entries(map)
    .filter(([, q]) => q > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([unit, q]) => `${(Math.round(q * 100) / 100).toLocaleString('en-IN')} ${unit}`)
    .join(' · ');
}

function lineGroups(orders, keyOf, labelOf) {
  const map = new Map();
  for (const order of orders) {
    for (const item of order.items || []) {
      const key = keyOf(item);
      if (!key) continue;
      const g = map.get(key) || { key, name: labelOf(item), value: 0, units: {}, orders: new Set(), customers: new Set() };
      g.value = money(g.value + (Number(item.amount) || 0));
      const unit = item.unit || 'pcs';
      g.units[unit] = (g.units[unit] || 0) + (Number(item.quantity) || 0);
      g.orders.add(String(order._id));
      g.customers.add(customerKey(order));
      map.set(key, g);
    }
  }
  const total = [...map.values()].reduce((s, g) => s + g.value, 0);
  return [...map.values()]
    .map((g) => ({ key: g.key, name: g.name, value: g.value, quantityText: unitText(g.units), orders: g.orders.size, customers: g.customers.size, share: total > 0 ? Math.round((g.value / total) * 1000) / 10 : null }))
    .sort((a, b) => b.value - a.value);
}

async function salesReport(user, query) {
  if (!canSee(user)) throw new ApiError(403, 'You cannot see the sales reports');
  const range = parseRange(query);
  const now = Date.now();
  const all = await SalesOrder.find({ status: { $ne: SALES_ORDER_STATUSES.DRAFT } })
    .select('number status orderType customer customerSnapshot orderDate deliveryDate grandTotal sourceIntake items.product items.productCode items.productType items.material items.size items.thickness items.color items.quantity items.unit items.amount')
    .lean();
  const live = all.filter((o) => o.status !== SALES_ORDER_STATUSES.CANCELLED);
  const booked = live.filter((o) => inRange(o.orderDate, range));
  const previous = live.filter((o) => inRange(o.orderDate, range.previous));
  const cancelled = all.filter((o) => o.status === SALES_ORDER_STATUSES.CANCELLED && inRange(o.orderDate, range));

  // First and last order of each customer, over all time.
  const history = new Map();
  for (const o of live) {
    const key = customerKey(o);
    const h = history.get(key) || { key, id: o.customer ? String(o.customer) : '', name: nameOf(o), code: o.customerSnapshot?.code || '', first: o.orderDate, last: o.orderDate, orders: [] };
    if (new Date(o.orderDate) < new Date(h.first)) h.first = o.orderDate;
    if (new Date(o.orderDate) > new Date(h.last)) {
      h.last = o.orderDate;
      h.name = nameOf(o);
    }
    h.orders.push(o);
    history.set(key, h);
  }

  const monthly = new Map(monthsOf(range.from, range.to).map((m) => [m, { month: m, orders: 0, salesOrders: 0, jobWork: 0, value: 0 }]));
  for (const o of booked) {
    const row = monthly.get(monthOf(o.orderDate));
    if (!row) continue;
    const value = Number(o.grandTotal) || 0;
    row.orders += 1;
    row.value = money(row.value + value);
    if (isJobWork(o)) row.jobWork = money(row.jobWork + value);
    else row.salesOrders = money(row.salesOrders + value);
  }

  const byCustomer = new Map();
  for (const o of booked) {
    const key = customerKey(o);
    const c = byCustomer.get(key) || { key, id: o.customer ? String(o.customer) : '', name: nameOf(o), code: o.customerSnapshot?.code || '', orders: 0, value: 0, jobWork: 0, last: null };
    c.orders += 1;
    c.value = money(c.value + (Number(o.grandTotal) || 0));
    if (isJobWork(o)) c.jobWork += 1;
    if (!c.last || new Date(o.orderDate) > new Date(c.last)) c.last = o.orderDate;
    byCustomer.set(key, c);
  }
  const bookedValue = money(booked.reduce((s, o) => s + (Number(o.grandTotal) || 0), 0));
  const customers = [...byCustomer.values()]
    .map((c) => {
      const h = history.get(c.key);
      return { ...c, isNew: inRange(h.first, range), firstOrder: h.first, share: bookedValue > 0 ? Math.round((c.value / bookedValue) * 1000) / 10 : null, average: c.orders ? money(c.value / c.orders) : 0 };
    })
    .sort((a, b) => b.value - a.value);
  const newCustomers = customers.filter((c) => c.isNew).length;

  const lapsed = [...history.values()]
    .map((h) => {
      const since = Math.floor((now - new Date(h.last).getTime()) / DAY);
      const lastYear = h.orders.filter((o) => now - new Date(o.orderDate).getTime() <= LAPSED_LOOKBACK_DAYS * DAY);
      return { key: h.key, id: h.id, name: h.name, code: h.code, lastOrder: h.last, daysSince: since, ordersLastYear: lastYear.length, valueLastYear: money(lastYear.reduce((s, o) => s + (Number(o.grandTotal) || 0), 0)), ordersEver: h.orders.length };
    })
    .filter((c) => c.daysSince >= LAPSED_DAYS && c.daysSince <= LAPSED_LOOKBACK_DAYS)
    .sort((a, b) => b.valueLastYear - a.valueLastYear);

  const pipeline = OPEN_STATUSES.filter((s) => STATUS_LABEL[s]).map((status) => {
    const rows = live.filter((o) => o.status === status);
    return { status, label: STATUS_LABEL[status], orders: rows.length, value: money(rows.reduce((s, o) => s + (Number(o.grandTotal) || 0), 0)) };
  });
  const lateOpen = live.filter((o) => STATUS_LABEL[o.status] && o.deliveryDate && new Date(o.deliveryDate).getTime() < now - DAY / 2);

  const jobWorkValue = money(booked.filter(isJobWork).reduce((s, o) => s + (Number(o.grandTotal) || 0), 0));
  const prevValue = money(previous.reduce((s, o) => s + (Number(o.grandTotal) || 0), 0));
  const fromDrafts = booked.filter((o) => o.sourceIntake).length;

  return {
    from: range.from,
    to: range.to,
    previous: { from: range.previous.from, to: range.previous.to },
    generatedAt: new Date(),
    kpis: {
      bookedValue,
      bookedDelta: deltaPct(bookedValue, prevValue),
      orders: booked.length,
      ordersDelta: deltaPct(booked.length, previous.length),
      averageOrder: booked.length ? money(bookedValue / booked.length) : 0,
      customers: customers.length,
      newCustomers,
      repeatCustomers: customers.length - newCustomers,
      jobWorkValue,
      jobWorkShare: bookedValue > 0 ? Math.round((jobWorkValue / bookedValue) * 1000) / 10 : null,
      cancelled: cancelled.length,
      cancelledValue: money(cancelled.reduce((s, o) => s + (Number(o.grandTotal) || 0), 0)),
      lapsedCustomers: lapsed.length,
      openOrders: pipeline.reduce((s, p) => s + p.orders, 0),
      openValue: money(pipeline.reduce((s, p) => s + p.value, 0)),
      lateOpenOrders: lateOpen.length,
      fromDrafts,
      lapsedDays: LAPSED_DAYS,
    },
    monthly: [...monthly.values()],
    customers,
    products: lineGroups(booked, (i) => i.productCode || i.product, (i) => (i.product && i.productCode && i.product !== i.productCode ? `${i.product} (${i.productCode})` : i.product || i.productCode)),
    materials: lineGroups(booked, (i) => i.material || 'Not set', (i) => i.material || 'Not set'),
    sizes: lineGroups(booked, (i) => [i.size, i.thickness && `${i.thickness} gauge`].filter(Boolean).join(' · ') || 'Not set', (i) => [i.size, i.thickness && `${i.thickness} gauge`].filter(Boolean).join(' · ') || 'Not set'),
    lapsed,
    pipeline,
    cancelledOrders: cancelled.map((o) => ({ id: String(o._id), number: o.number, date: o.orderDate, customer: nameOf(o), value: money(o.grandTotal) })),
  };
}

module.exports = { salesReport, OPEN_STATUSES, STATUS_LABEL };
