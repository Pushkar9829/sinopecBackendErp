const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5', overdueHoldDays: 30 });
});
after(h.stopApp);

// Lines copied from a seeded order that already passed submit (all production details filled).
async function completeLines() {
  const source = await db.collection('salesorders').findOne({ status: 'approved', orderType: 'sales_order' });
  return source.items.map(({ _id, stageWork, currentStage, stagePickup, ...rest }) => rest);
}

async function submittedOrder(customerId) {
  const created = await owner.post('/api/sales-orders', { customerId, deliveryDate: '2099-01-01', items: await completeLines() });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const submitted = await owner.post(`/api/sales-orders/${created.data.data.id}/submit`, {});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
  return submitted.data.data;
}

test('over the credit limit: submit records a hold, approve needs the owner reason', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Tight Limit Ltd', creditLimit: 5000 })).data.data;
  const order = await submittedOrder(customer.id);
  assert.equal(order.creditCheck.status, 'hold');
  assert.match(order.creditCheck.reasons[0], /credit limit/);
  assert.equal(order.creditCheck.exposure, order.grandTotal);

  const refused = await owner.post(`/api/sales-orders/${order.id}/approve`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.data.message, /Credit hold/);
  const approved = await owner.post(`/api/sales-orders/${order.id}/approve`, { creditOverrideReason: 'Owner knows them, pays on delivery' });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.data.status, 'approved');
  assert.equal(approved.data.data.creditOverride.reason, 'Owner knows them, pays on delivery');
});

test('within the limit and nothing overdue: approved straight away', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Roomy Limit Ltd', creditLimit: 1000000 })).data.data;
  const order = await submittedOrder(customer.id);
  assert.equal(order.creditCheck.status, 'ok');
  assert.equal((await owner.post(`/api/sales-orders/${order.id}/approve`, {})).status, 200);
});

test('a bill overdue longer than the company allows puts new orders on hold', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Slow Payer Co' })).data.data;
  await owner.post(`/api/billing/customers/${customer.id}/openings`, { number: 'OLD-9', date: '2026-01-01', amount: 4000, dueDate: '2026-02-01' });
  const order = await submittedOrder(customer.id);
  assert.equal(order.creditCheck.status, 'hold');
  assert.match(order.creditCheck.reasons.join(' '), /days overdue/);
  // Paying the old bill clears the hold at approval time.
  await owner.post(`/api/billing/customers/${customer.id}/receipts`, { amount: 4000 });
  const approved = await owner.post(`/api/sales-orders/${order.id}/approve`, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.data.creditCheck.status, 'ok');
});

test('floor users never see the credit check', async () => {
  const order = await db.collection('salesorders').findOne({ creditCheck: { $ne: null } });
  const production = await h.signIn('production');
  const view = (await production.get(`/api/sales-orders/${order._id}`)).data.data;
  assert.equal(view.creditCheck, undefined);
});

test('overdue follow-up tasks: one per customer for Accounts, closed once paid', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Task Test Traders' })).data.data;
  await owner.post(`/api/billing/customers/${customer.id}/openings`, { number: 'T-1', date: '2026-05-01', amount: 2500, dueDate: '2026-06-01' });
  const billing = require('../src/modules/billing/billing.service');
  await billing.syncOverdueTasks();
  await billing.syncOverdueTasks();
  const tasks = await db.collection('tasks').find({ category: 'payment_overdue', customer: h.asId(customer.id) }).toArray();
  assert.equal(tasks.length, 1, 'not duplicated by a second run');
  assert.equal(tasks[0].assigneeRole, 'accounts');
  assert.match(tasks[0].title, /2,500/);
  await owner.post(`/api/billing/customers/${customer.id}/receipts`, { amount: 2500 });
  await billing.syncOverdueTasks();
  assert.equal((await db.collection('tasks').findOne({ _id: tasks[0]._id })).status, 'done');
});

test('receivables: every customer with a balance, with totals and ageing', async () => {
  const report = (await owner.get('/api/billing/receivables')).data.data;
  assert.ok(report.rows.length >= 1);
  const sum = report.rows.reduce((s, r) => s + r.outstanding, 0);
  assert.ok(Math.abs(sum - report.totals.outstanding) < 0.01);
  const production = await h.signIn('production');
  assert.equal((await production.get('/api/billing/receivables')).status, 403);
});
