const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
});
after(h.stopApp);

test('orders list pages on the server and matches the full list', async () => {
  const full = (await owner.get('/api/sales-orders')).data.data;
  const page1 = (await owner.get('/api/sales-orders?page=1&pageSize=8')).data.data;
  assert.equal(page1.total, full.length);
  assert.equal(page1.items.length, Math.min(8, full.length));
  assert.equal(page1.counts.all, full.length);
  const all = (await owner.get('/api/sales-orders?page=1&pageSize=100')).data.data;
  assert.deepEqual(all.items.map((o) => o.id).sort(), full.map((o) => o.id).sort());
  for (const row of all.items) {
    const order = full.find((o) => o.id === row.id);
    assert.equal(row.grandTotal, order.grandTotal);
  }
  const open = (await owner.get('/api/sales-orders?page=1&pageSize=100&status=open')).data.data;
  assert.ok(open.items.every((o) => !['cancelled', 'completed'].includes(o.status)));
  const search = (await owner.get('/api/sales-orders?page=1&pageSize=100&q=SO-2026')).data.data;
  assert.ok(search.items.every((o) => o.number.includes('SO-2026')));
});

test('roles see the same orders paged as before, and totals only with price access', async () => {
  for (const user of ['dispatch', 'production', 'sales']) {
    const c = await h.signIn(user);
    const full = (await c.get('/api/sales-orders')).data.data;
    const paged = (await c.get('/api/sales-orders?page=1&pageSize=100')).data.data;
    assert.deepEqual(paged.items.map((o) => o.id).sort(), full.map((o) => o.id).sort(), user);
    assert.equal(paged.items.some((r) => 'grandTotal' in r), user === 'sales', user);
  }
});

test('tasks list pages on the server in the same order as before', async () => {
  const full = (await owner.get('/api/tasks?scope=all&status=any')).data.data;
  const pages = [];
  for (let page = 1; ; page += 1) {
    const data = (await owner.get(`/api/tasks?scope=all&status=any&page=${page}&pageSize=7`)).data.data;
    pages.push(...data.items);
    if (page >= data.pages) break;
  }
  assert.deepEqual(pages.map((t) => t.id), full.map((t) => t.id));
  assert.equal((await owner.get('/api/tasks?scope=queue')).status, 200);
});

test('customers list carries a product count, not the products', async () => {
  const list = (await owner.get('/api/customers')).data.data;
  assert.ok(list.length > 0);
  for (const c of list) {
    assert.deepEqual(c.products, []);
    assert.equal(typeof c.productCount, 'number');
  }
  const customer = await db.collection('customers').findOne({});
  await db.collection('customers').updateOne({ _id: customer._id }, { $push: { products: { product: 'Legacy thing', productionRoute: 'route_that_no_longer_exists' } } });
  assert.equal((await owner.get('/api/customers')).status, 200, 'one bad stored product must not break the list');
  assert.equal((await owner.get(`/api/customers/${customer._id}`)).status, 200);
});

test('registers and the floor queue load, and reading them changes nothing', async () => {
  const registersBefore = await db.collection('registers').find({}).toArray();
  assert.equal((await owner.get('/api/registers')).status, 200);
  assert.equal((await owner.get('/api/registers/stage/rolling')).status, 200);
  assert.equal((await owner.get('/api/production/queue?stage=rolling')).status, 200);
  await owner.get('/api/registers');
  const registersAfter = await db.collection('registers').find({}).toArray();
  const versions = (docs) => Object.fromEntries(docs.map((d) => [String(d._id), d.__v]));
  // The first read may create/sync registers; a second identical read must not write again.
  await owner.get('/api/registers');
  assert.deepEqual(versions(await db.collection('registers').find({}).toArray()), versions(registersAfter));
  assert.ok(registersBefore.length <= registersAfter.length);
});

test('analytics: range capped, names hidden from non-admins, cancelled work left out', async () => {
  const wide = await owner.get('/api/analytics?from=1900-01-01');
  assert.equal(wide.status, 200);
  assert.ok(wide.data.data.byDate.length <= 366);
  const production = await h.signIn('production');
  const report = (await production.get('/api/analytics?from=2026-01-01')).data.data;
  const names = new Set((await db.collection('customers').find({}).toArray()).map((c) => c.name));
  assert.ok(!report.orders.some((r) => names.has(r.customer)));
  const cancelled = new Set((await db.collection('salesorders').find({ status: 'cancelled' }).toArray()).map((o) => String(o._id)));
  const all = (await owner.get('/api/analytics?from=2025-01-01')).data.data;
  assert.ok(!all.details.some((row) => cancelled.has(row.orderId)), 'no work rows from cancelled orders');
});

test('task due dates end at 23:59:59 India time', async () => {
  const res = await owner.post('/api/tasks', { title: 'TZ test', dueDate: '2026-10-20', assigneeRole: 'sales_manager', category: 'general' });
  assert.equal(res.status, 201);
  assert.equal(new Date(res.data.data.dueDate).toISOString(), '2026-10-20T18:29:59.000Z');
});

test('once a teammate claims a floor task, only they (or a manager) can change it', async () => {
  const rolling = await db.collection('users').findOne({ username: 'rolling' });
  const task = await db.collection('tasks').findOne({ category: 'stage_work', assigneeRole: 'rolling_operator', assignee: rolling._id, status: 'in_progress' });
  assert.ok(task, 'seeded rolling task claimed by the rolling operator');
  const role = await db.collection('roles').findOne({ slug: 'rolling_operator' });
  await owner.post('/api/users', { username: 'rolling2', password: 'RollingTwo#2026', fullName: 'Second Roller', roleId: String(role._id) });
  const first = await h.signIn('rolling');
  const second = await h.signIn('rolling2', 'RollingTwo#2026');
  assert.equal((await second.patch(`/api/tasks/${task._id}`, { status: 'blocked', note: 'not mine' })).status, 403);
  assert.equal((await first.patch(`/api/tasks/${task._id}`, { status: 'blocked', note: 'waiting for material' })).status, 200);
});

test('small validations: rate calculator clamps negatives, big bodies refused off order routes, unique machine codes', async () => {
  const rc = await owner.post('/api/rate-calculator/sales-order', { width: -10, length: 10, gauge: 50, divisor: 3300, materialRate: 100 });
  assert.ok(!(rc.data.data?.weight < 0));
  assert.equal((await owner.post('/api/machines', { name: 'x'.repeat(2 * 1024 * 1024) })).status, 413);
  assert.ok([200, 201].includes((await owner.post('/api/machines', { name: 'Dup A', code: 'DUPX1' })).status));
  assert.ok((await owner.post('/api/machines', { name: 'Dup B', code: 'dupx1' })).status >= 400);
});
