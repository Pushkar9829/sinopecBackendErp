// The two routes outside the film stages: "Other process → Dispatch" (a named
// process such as Lamination, recorded by production managers, no stock taken)
// and "Direct dispatch" (ready or trading goods sent with no making and no stock).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
let orders;
let lots;
let tasks;
let customerId;

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  orders = db.collection('salesorders');
  lots = db.collection('inventoryitems');
  tasks = db.collection('tasks');
  customerId = (await owner.post('/api/customers', { name: 'Other Route Traders' })).data.data.id;
  assert.equal((await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5', invoicePrefix: 'OR' })).status, 200);
});
after(h.stopApp);

const DISPATCH = { deliveryPartner: 'In-house', handoverPerson: 'Driver', vehicleNumber: 'RJ14 AB 1234' };

function line(route, extra = {}) {
  return {
    product: 'Laminated pouch',
    productCode: 'LP-1',
    productType: 'Finished Product',
    width: '10',
    length: '12',
    material: 'BOPP',
    quantity: 500,
    unit: 'pcs',
    rate: 4,
    taxPercent: 18,
    productionRoute: route,
    ...extra,
  };
}

// Draft → submit → approve → plan, returning the planned order.
async function plannedOrder(items, orderType = 'sales_order') {
  const created = await owner.post('/api/sales-orders', { customerId, orderType, deliveryDate: '2099-01-01', items });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.data.id;
  let res = await owner.post(`/api/sales-orders/${id}/submit`, {});
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await owner.post(`/api/sales-orders/${id}/approve`, {});
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await owner.post(`/api/sales-orders/${id}/plan-production`, {});
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.data;
}

const enter = (client, order, stage, body) =>
  client.post('/api/production/enter', { orderId: order.id, itemId: order.items[0].id, stage, ...body });

async function stockSnapshot() {
  const rows = await lots.find({}, { projection: { quantity: 1 } }).toArray();
  return new Map(rows.map((row) => [String(row._id), row.quantity]));
}

async function invoiceAll(order, quantity) {
  const draft = (await owner.get(`/api/billing/orders/${order.id}/invoice-draft`)).data.data;
  const row = draft.lines.find((l) => l.itemId === order.items[0].id);
  assert.equal(row.dispatched, quantity);
  assert.equal(row.suggested, quantity);
  const res = await owner.post(`/api/billing/orders/${order.id}/invoices`, { lines: [{ itemId: row.itemId, quantity }] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.data;
}

test('Other process needs a process name, kept to 60 characters', async () => {
  let res = await owner.post('/api/sales-orders', { customerId, items: [line('other_dispatch')] });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /process name/);
  res = await owner.post('/api/sales-orders', { customerId, items: [line('other_dispatch', { otherProcess: 'x'.repeat(61) })] });
  assert.equal(res.status, 400);
  res = await owner.post('/api/sales-orders', { customerId, items: [line('other_dispatch', { otherProcess: '  Lamination ' })] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.data.items[0].otherProcess, 'Lamination');
  // Film fields do not apply and are not kept.
  assert.equal(res.data.data.items[0].printing.required, false);
  // A film route drops a stray process name.
  res = await owner.post('/api/sales-orders', { customerId, items: [line('roll_dispatch', { otherProcess: 'Lamination' })] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.data.items[0].otherProcess, '');
});

test('Other process → Dispatch: manager records the process, dispatch, delivered, invoiced', async () => {
  const order = await plannedOrder([line('other_dispatch', { otherProcess: 'Lamination' })]);
  assert.equal(order.status, 'production_planned');
  assert.equal(order.items[0].currentStage, 'other');

  // Task for the process step goes to production managers, named after it.
  const stageTask = await tasks.findOne({ order: h.asId(order.id), category: 'stage_work', stage: 'other', status: { $in: ['open', 'in_progress'] } });
  assert.ok(stageTask, 'a task for the other stage');
  assert.equal(stageTask.assigneeRole, 'production_manager');
  assert.match(stageTask.title, /^Lamination - item 1/);

  // The queue shows it with no stock needed.
  const production = await h.signIn('production');
  const queue = (await production.get('/api/production/queue?stage=other')).data.data;
  const job = queue.jobs.find((j) => j.orderId === order.id);
  assert.ok(job, 'job on the other queue');
  assert.equal(job.noStock, true);
  assert.equal(job.otherProcess, 'Lamination');
  assert.equal(job.requirements.process, 'Lamination');

  // Operators cannot record or see it.
  const rolling = await h.signIn('rolling');
  assert.equal((await enter(rolling, order, 'other', { outputQty: 10 })).status, 403);
  assert.equal((await rolling.get('/api/production/queue?stage=other')).status, 403);

  const before = await stockSnapshot();
  let res = await enter(production, order, 'other', { outputQty: 300, wasteQty: 5, inputQty: 12, notes: 'first shift' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await enter(production, order, 'other', { outputQty: 300 });
  assert.equal(res.status, 400, 'capped at the line quantity');
  res = await enter(production, order, 'other', { outputQty: 200 });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const after = await stockSnapshot();
  for (const [id, qty] of before) assert.equal(after.get(id), qty, 'no existing lot changed');

  const saved = await orders.findOne({ _id: h.asId(order.id) });
  const item = saved.items[0];
  assert.equal(saved.status, 'ready_for_dispatch');
  assert.equal(item.currentStage, 'dispatch');
  const rows = item.stageWork.filter((w) => w.stage === 'other');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].inputQty, 12);
  assert.equal(rows[0].wasteUnit, 'pcs');
  const wip = await lots.find({ salesOrder: h.asId(order.id), kind: 'wip', wipStage: 'other', category: 'output' }).toArray();
  assert.equal(wip.reduce((s, l) => s + l.quantity, 0), 500, 'output lots for dispatch');

  // Register: the stage tab carries the process name, entries can be edited.
  const book = (await owner.get(`/api/registers/order/${order.id}`)).data.data;
  const otherTab = book.stages.find((s) => s.id === 'other');
  assert.equal(otherTab.lines[0].process, 'Lamination');
  assert.equal(otherTab.lines[0].entries.length, 2);
  const entryId = otherTab.lines[0].entries[1].id;
  res = await production.post('/api/production/entry/update', { orderId: order.id, entryId, outputQty: 150 });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await production.post('/api/production/entry/update', { orderId: order.id, entryId, outputQty: 200 });
  assert.equal(res.status, 200, JSON.stringify(res.data));

  // Job sheet shows the process.
  const sheet = (await owner.get(`/api/production/job-sheet/${order.id}`)).data.data;
  const page = sheet.stages.find((s) => s.stage === 'other');
  assert.equal(page.lines[0].process, 'Lamination');
  assert.ok(page.lines[0].specs.some((s) => s.label === 'Process' && s.value === 'Lamination'));

  // Dispatch takes the other stage's output, as for any route.
  const dispatcher = await h.signIn('dispatch');
  for (const lot of await lots.find({ salesOrder: h.asId(order.id), kind: 'wip', wipStage: 'other', category: 'output', quantity: { $gt: 0 } }).toArray()) {
    res = await enter(dispatcher, order, 'dispatch', { outputQty: lot.quantity, lotId: String(lot._id), ...DISPATCH });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  }
  const delivered = await orders.findOne({ _id: h.asId(order.id) });
  assert.equal(delivered.status, 'delivered');

  const invoice = await invoiceAll(order, 500);
  assert.equal(invoice.lines[0].quantity, 500);

  // Reports pick up the other stage.
  const report = (await owner.get('/api/reports/production')).data.data;
  assert.ok(report.stages.some((s) => s.stage === 'other' && s.output >= 500));
});

test('Direct dispatch: plan goes straight to dispatch, no stock moves, delivered and invoiced', async () => {
  const order = await plannedOrder([line('direct_dispatch', { product: 'Trading tape' })]);
  assert.equal(order.status, 'ready_for_dispatch');
  assert.equal(order.items[0].currentStage, 'dispatch');

  const dispatchTask = await tasks.findOne({ order: h.asId(order.id), category: 'dispatch', status: { $in: ['open', 'in_progress'] } });
  assert.ok(dispatchTask, 'a dispatch task');
  assert.equal(await tasks.countDocuments({ order: h.asId(order.id), category: 'stage_work' }), 0);

  const dispatcher = await h.signIn('dispatch');
  const queue = (await dispatcher.get('/api/production/queue?stage=dispatch')).data.data;
  const job = queue.jobs.find((j) => j.orderId === order.id);
  assert.ok(job, 'job on the dispatch queue');
  assert.equal(job.noStock, true);
  assert.deepEqual(job.sourceLots, []);

  const register = (await dispatcher.get('/api/registers/stage/dispatch')).data.data;
  assert.ok(register.open.some((row) => row.orderId === order.id && row.canMark), 'open to enter on the register');

  const before = await stockSnapshot();
  let res = await enter(dispatcher, order, 'dispatch', { outputQty: 200, ...DISPATCH });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal((await orders.findOne({ _id: h.asId(order.id) })).status, 'dispatched');
  res = await enter(dispatcher, order, 'dispatch', { outputQty: 400, ...DISPATCH });
  assert.equal(res.status, 400, 'no more than ordered');
  res = await dispatcher.post('/api/production/pickup', { orderId: order.id, itemId: order.items[0].id, stage: 'dispatch', lotId: [...before.keys()][0], qty: 1 });
  assert.equal(res.status, 400, 'nothing to pick on direct dispatch');
  res = await enter(dispatcher, order, 'dispatch', { outputQty: 300, ...DISPATCH });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const after = await stockSnapshot();
  assert.equal(after.size, before.size, 'no lot made');
  for (const [id, qty] of before) assert.equal(after.get(id), qty, 'no lot changed');

  const saved = await orders.findOne({ _id: h.asId(order.id) });
  assert.equal(saved.status, 'delivered');
  const rows = saved.items[0].stageWork;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.inputQty === 0 && !r.sourceLot && !r.fromStage));

  // A dispatch row can be changed and deleted without touching stock.
  const book = (await owner.get(`/api/registers/order/${order.id}`)).data.data;
  const entries = book.stages.find((s) => s.id === 'dispatch').lines[0].entries;
  assert.ok(entries.every((e) => e.noStock), 'entries say no stock was taken');
  res = await owner.post('/api/production/entry/update', { orderId: order.id, entryId: entries[1].id, outputQty: 250 });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  res = await owner.post('/api/production/entry/delete', { orderId: order.id, entryId: entries[1].id });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const afterEdit = await stockSnapshot();
  assert.equal(afterEdit.size, before.size, 'no returned lot made');
  for (const [id, qty] of before) assert.equal(afterEdit.get(id), qty);
  res = await enter(dispatcher, order, 'dispatch', { outputQty: 300, ...DISPATCH });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal((await orders.findOne({ _id: h.asId(order.id) })).status, 'delivered');

  await invoiceAll(order, 500);
  const report = (await owner.get('/api/reports/dispatch')).data.data;
  assert.ok(report.entries.some((e) => e.orderId === order.id));
});

test('job work can use both routes, and a job work Other process is not held for customer material', async () => {
  const order = await plannedOrder(
    [line('other_dispatch', { otherProcess: 'Packing in cartons' }), line('direct_dispatch', { product: 'Spare rolls', productCode: 'SR-1' })],
    'job_work'
  );
  assert.equal(order.orderType, 'job_work');
  const stageTask = await tasks.findOne({ order: h.asId(order.id), category: 'stage_work', stage: 'other' });
  assert.ok(stageTask, 'task for the other stage even before customer material arrives');
  assert.match(stageTask.title, /^Packing in cartons/);
  const production = await h.signIn('production');
  assert.equal((await enter(production, order, 'other', { outputQty: 500 })).status, 200);
  const direct = { ...order, items: [order.items[1]] };
  assert.equal((await enter(owner, direct, 'dispatch', { outputQty: 500, ...DISPATCH })).status, 200);
  const saved = await orders.findOne({ _id: h.asId(order.id) });
  assert.equal(saved.status, 'dispatched', 'one line sent, the other ready to send');
});

test('saved products and customer products keep the new routes', async () => {
  let res = await owner.post('/api/sales-settings/templates', { name: 'Lamination job', ...line('other_dispatch', { otherProcess: 'Lamination' }) });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.data.otherProcess, 'Lamination');
  res = await owner.post('/api/sales-settings/templates', { name: 'Ready goods', ...line('direct_dispatch') });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  res = await owner.post('/api/customers', { name: 'Route Keeper', products: [line('other_dispatch', { otherProcess: 'Lamination' }), line('direct_dispatch', { product: 'Tape' })] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const products = res.data.data.products;
  assert.equal(products[0].otherProcess, 'Lamination');
  assert.equal(products[1].productionRoute, 'direct_dispatch');
  assert.ok(!products.some((p) => p.needsReview));
});
