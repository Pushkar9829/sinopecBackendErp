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

test('stock report: value is quantity × price, by category, and lots add up', async () => {
  const res = await owner.get(`/api/reports/stock?${period}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const r = res.data.data;
  const lots = await db.collection('inventoryitems').find({ isActive: true, quantity: { $gt: 0 } }).toArray();
  assert.equal(r.kpis.lotsInStock, lots.length);
  const value = (cat) => Math.round(lots.filter((l) => l.category === cat && l.unitPrice != null).reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100) / 100;
  assert.ok(Math.abs(r.kpis.rawValue - value('raw')) < 0.05);
  assert.ok(Math.abs(r.kpis.outputValue - value('output')) < 0.05);
  assert.equal(r.categories.reduce((s, c) => s + c.lots, 0), lots.length);
  assert.ok(r.lots.every((l) => l.category !== 'waste' || l.value === null), 'waste has no value');
  assert.ok(r.slow.every((l) => l.idleDays >= 30));
});

test('stock report: material used at rolling matches the floor entries', async () => {
  const r = (await owner.get(`/api/reports/stock?${period}`)).data.data;
  const orders = await db.collection('salesorders').find({ status: { $ne: 'cancelled' } }).toArray();
  const start = new Date('2026-01-01T00:00:00+05:30');
  const end = new Date('2026-12-31T23:59:59+05:30');
  const input = orders.flatMap((o) => o.items.flatMap((i) => i.stageWork.filter((w) => w.stage === 'rolling' && w.workDate >= start && w.workDate <= end))).reduce((s, w) => s + (w.inputQty || 0), 0);
  assert.ok(Math.abs(r.kpis.materialUsedKg - input) < 0.05);
});

test('operations report: tasks and draft orders, owner only', async () => {
  const res = await owner.get(`/api/reports/operations?${period}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const r = res.data.data;
  const open = await db.collection('tasks').countDocuments({ status: { $in: ['open', 'in_progress', 'blocked'] } });
  assert.equal(r.kpis.tasksOpen, open);
  assert.equal(r.people.reduce((s, p) => s + p.open, 0), open);
  assert.equal(r.draftOutcomes.reduce((s, o) => s + o.count, 0), r.kpis.draftsReceived);
  assert.equal(r.draftsByChannel.reduce((s, c) => s + c.received, 0), r.kpis.draftsReceived);
  const production = await h.signIn('production');
  assert.equal((await production.get('/api/reports/operations')).status, 403);
  assert.equal((await production.get('/api/reports/stock')).status, 200);
  const accounts = await h.signIn('accounts');
  assert.equal((await accounts.get('/api/reports/stock')).status, 403);
});
