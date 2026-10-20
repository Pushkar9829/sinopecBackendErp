const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
const period = 'from=2026-01-01&to=2026-12-31';

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
});
after(h.stopApp);

const inYear = (o) => o.orderDate >= new Date('2026-01-01T00:00:00+05:30') && o.orderDate <= new Date('2026-12-31T23:59:59+05:30');

test('sales report: booked orders, months, customers and products add up', async () => {
  const res = await owner.get(`/api/reports/sales?${period}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const r = res.data.data;
  const orders = (await db.collection('salesorders').find({ status: { $nin: ['draft', 'cancelled'] } }).toArray()).filter(inYear);
  const value = Math.round(orders.reduce((s, o) => s + (o.grandTotal || 0), 0) * 100) / 100;
  assert.equal(r.kpis.orders, orders.length);
  assert.ok(Math.abs(r.kpis.bookedValue - value) < 0.01);
  assert.equal(r.monthly.length, 12);
  assert.ok(Math.abs(r.monthly.reduce((s, m) => s + m.value, 0) - value) < 0.05, 'months add up');
  assert.ok(Math.abs(r.monthly.reduce((s, m) => s + m.salesOrders + m.jobWork, 0) - value) < 0.05, 'sales orders + job work = all');
  assert.ok(Math.abs(r.customers.reduce((s, c) => s + c.value, 0) - value) < 0.05, 'customers add up');
  assert.equal(r.customers.reduce((s, c) => s + c.orders, 0), orders.length);
  assert.equal(r.kpis.newCustomers + r.kpis.repeatCustomers, r.kpis.customers);
  const lineValue = orders.flatMap((o) => o.items || []).reduce((s, i) => s + (i.amount || 0), 0);
  assert.ok(Math.abs(r.products.reduce((s, p) => s + p.value, 0) - lineValue) < 0.05, 'products add up to the order lines');
  assert.ok(r.pipeline.every((p) => p.label && p.orders >= 0));
});

test('a customer whose last order is over 60 days old shows as stopped ordering', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Quiet Buyer Co' })).data.data;
  const source = await db.collection('salesorders').findOne({ status: 'approved' });
  const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
  await db.collection('salesorders').insertOne({ ...source, _id: undefined, number: 'SO-TEST-OLD', customer: h.asId(customer.id), customerSnapshot: { ...source.customerSnapshot, name: 'Quiet Buyer Co', companyName: 'Quiet Buyer Co', code: customer.code }, orderDate: old, status: 'completed' });
  const r = (await owner.get('/api/reports/sales')).data.data;
  const row = r.lapsed.find((c) => c.name === 'Quiet Buyer Co');
  assert.ok(row, 'listed');
  assert.ok(row.daysSince >= 99 && row.daysSince <= 101);
});

test('owner overview combines the areas; only the owner and the right roles get each report', async () => {
  const res = await owner.get(`/api/reports/overview?${period}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const o = res.data.data;
  const sales = (await owner.get(`/api/reports/sales?${period}`)).data.data;
  const accounts = (await owner.get(`/api/reports/accounts?${period}`)).data.data;
  assert.equal(o.money.booked, sales.kpis.bookedValue);
  assert.equal(o.money.billed, accounts.kpis.billed);
  assert.equal(o.monthly.length, 12);
  assert.ok(o.attention.length >= 6 && o.attention.every((a) => a.to && a.label));

  const salesUser = await h.signIn('sales');
  assert.equal((await salesUser.get('/api/reports/sales')).status, 200);
  assert.equal((await salesUser.get('/api/reports/overview')).status, 403);
  const accountsUser = await h.signIn('accounts');
  assert.equal((await accountsUser.get('/api/reports/sales')).status, 403);
  assert.equal((await accountsUser.get('/api/reports/overview')).status, 403);
  const production = await h.signIn('production');
  assert.equal((await production.get('/api/reports/sales')).status, 403);
});
