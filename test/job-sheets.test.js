const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { routeStages, activeStage } = require('../src/modules/production/production.flow');

let db;
let owner;
let order;
before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  // An order whose lines go through printing as well as rolling.
  order = await db.collection('salesorders').findOne({ status: { $in: ['in_production', 'production_planned'] }, 'items.productionRoute': { $regex: 'print' } });
  if (!order) order = await db.collection('salesorders').findOne({ status: { $in: ['in_production', 'production_planned'] } });
});
after(h.stopApp);

test('job sheet: one page per stage on the route, with specs, targets and entries so far', async () => {
  const res = await owner.get(`/api/production/job-sheet/${order._id}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const sheet = res.data.data;
  const onRoute = new Set(order.items.flatMap((i) => routeStages(i.productionRoute)));
  assert.deepEqual(sheet.stages.map((s) => s.stage).sort(), [...onRoute].sort());
  const rolling = sheet.stages.find((s) => s.stage === 'rolling');
  assert.ok(rolling.lines.length >= 1);
  const line = rolling.lines[0];
  assert.ok(line.specs.some((s) => s.label === 'Product'));
  assert.equal(line.unit, 'kg');
  const item = order.items.find((i) => String(i._id) === line.itemId);
  assert.equal(line.entries.length, item.stageWork.filter((w) => w.stage === 'rolling').length);
  assert.equal(sheet.order.customer, order.customerSnapshot.companyName || order.customerSnapshot.name, 'the owner sees the name');

  const one = (await owner.get(`/api/production/job-sheet/${order._id}?stage=rolling`)).data.data;
  assert.deepEqual(one.stages.map((s) => s.stage), ['rolling']);
});

test('an operator only gets the sheet of their own stage, with the customer code', async () => {
  const rolling = await h.signIn('rolling');
  const sheet = (await rolling.get(`/api/production/job-sheet/${order._id}`)).data.data;
  assert.deepEqual(sheet.stages.map((s) => s.stage), ['rolling']);
  assert.equal(sheet.order.customer, order.customerSnapshot.code);
  assert.equal((await rolling.get(`/api/production/job-sheet/${order._id}?stage=cutting`)).status, 403);
  const accounts = await h.signIn('accounts');
  assert.equal((await accounts.get(`/api/production/job-sheet/${order._id}`)).status, 403);
});

test('stage work list: every line whose current stage it is, urgent first', async () => {
  const res = await owner.get('/api/production/stage-sheet/rolling');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const sheet = res.data.data;
  const orders = await db.collection('salesorders').find({ status: { $in: ['production_planned', 'in_production', 'ready_for_packing', 'packed', 'ready_for_dispatch', 'dispatched'] } }).toArray();
  const expected = orders.flatMap((o) => o.items.filter((i) => routeStages(i.productionRoute).includes('rolling') && activeStage(i) === 'rolling'));
  assert.equal(sheet.lines.length, expected.length);
  const rank = { urgent: 0, high: 1, normal: 2 };
  const ranks = sheet.lines.map((l) => rank[l.priority] ?? 3);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal((await owner.get('/api/production/stage-sheet/nowhere')).status, 400);
});
