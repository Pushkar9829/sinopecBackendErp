const ApiError = require('../../utils/ApiError');
const { isSuperAdmin } = require('../../utils/permissions');
const { TASK_OPEN_STATUSES } = require('../../config/constants');
const Intake = require('../intake/intake.model');
const Task = require('../task/task.model');
const { getAnalytics } = require('../analytics/analytics.service');
const { accountsReport } = require('./reports.accounts');
const { salesReport } = require('./reports.sales');
const { parseRange } = require('./reports.range');

// The owner's one-page view: the headline figure from each area, and the
// things that need someone's attention today. Each figure links to its report.
async function overviewReport(user, query) {
  if (!isSuperAdmin(user)) throw new ApiError(403, 'Only the owner sees the overview');
  const range = parseRange(query);
  const period = { from: range.from, to: range.to };
  const now = new Date();
  const [accounts, sales, production, draftsToReview, draftsLate, tasksLate] = await Promise.all([
    accountsReport(user, period),
    salesReport(user, period),
    getAnalytics(user, period),
    Intake.countDocuments({ status: { $in: ['needs_review', 'customer_confirmed'] } }),
    Intake.countDocuments({ status: { $in: ['needs_review', 'customer_confirmed'] }, reviewDueAt: { $lt: now } }),
    Task.countDocuments({ status: { $in: TASK_OPEN_STATUSES }, dueDate: { $lt: now } }),
  ]);
  const p = production.kpis;
  const billedByMonth = new Map(accounts.monthly.map((m) => [m.month, m]));
  const waiting = sales.pipeline.find((s) => s.status === 'submitted');

  const attention = [
    { id: 'overdue_money', label: 'Money overdue from customers', value: accounts.kpis.overdue, format: 'money', to: '/receivables', bad: accounts.kpis.overdue > 0 },
    { id: 'late_orders', label: 'Open orders past their delivery date', value: p.overdue || 0, format: 'int', to: '/analytics', bad: (p.overdue || 0) > 0 },
    { id: 'at_risk', label: 'Orders due in the next 3 days', value: p.atRisk || 0, format: 'int', to: '/analytics' },
    { id: 'approval', label: 'Orders waiting for approval', value: waiting?.orders || 0, format: 'int', to: '/sales-orders' },
    { id: 'drafts', label: 'Draft orders to review', value: draftsToReview, format: 'int', to: '/draft-orders', bad: draftsLate > 0, hint: draftsLate ? `${draftsLate} past the review time` : '' },
    { id: 'tasks', label: 'Tasks past their due date', value: tasksLate, format: 'int', to: '/tasks', bad: tasksLate > 0 },
    { id: 'lapsed', label: `Customers with no order for ${sales.kpis.lapsedDays}+ days`, value: sales.kpis.lapsedCustomers, format: 'int', to: '/reports?tab=sales' },
    { id: 'overrides', label: 'Orders approved on credit hold (period)', value: accounts.kpis.creditOverrides, format: 'int', to: '/reports?tab=accounts' },
  ];

  return {
    from: range.from,
    to: range.to,
    previous: accounts.previous,
    generatedAt: new Date(),
    money: {
      booked: sales.kpis.bookedValue,
      bookedDelta: sales.kpis.bookedDelta,
      orders: sales.kpis.orders,
      billed: accounts.kpis.billed,
      billedDelta: accounts.kpis.billedDelta,
      collected: accounts.kpis.collected,
      collectedDelta: accounts.kpis.collectedDelta,
      outstanding: accounts.kpis.outstanding,
      overdue: accounts.kpis.overdue,
      gst: accounts.kpis.tax,
      dso: accounts.kpis.dso,
      openValue: sales.kpis.openValue,
      openOrders: sales.kpis.openOrders,
    },
    production: {
      // Production figures cover at most 366 days (the end of a longer period).
      from: production.from,
      to: production.to,
      outputText: p.outputText,
      outputDelta: p.previous?.outputDelta ?? null,
      wastePct: p.wastePct,
      wastePctDelta: p.previous?.wastePctDelta ?? null,
      yieldPct: p.yieldPct,
      dispatchedText: p.dispatchedText,
      delivered: p.delivered,
      onTimePct: p.onTimePct,
      avgLeadDays: p.avgLeadDays,
      operators: p.operators,
    },
    customers: {
      ordering: sales.kpis.customers,
      newCustomers: sales.kpis.newCustomers,
      repeatCustomers: sales.kpis.repeatCustomers,
      lapsed: sales.kpis.lapsedCustomers,
      top: sales.customers.slice(0, 5).map((c) => ({ id: c.id, name: c.name, value: c.value, orders: c.orders, share: c.share })),
      topDebtors: accounts.debtors.slice(0, 5).map((d) => ({ id: d.id, name: d.name, outstanding: d.outstanding, overdue: d.overdue })),
    },
    monthly: sales.monthly.map((m) => ({ month: m.month, booked: m.value, billed: billedByMonth.get(m.month)?.billed || 0, collected: billedByMonth.get(m.month)?.collected || 0 })),
    attention,
  };
}

module.exports = { overviewReport };
