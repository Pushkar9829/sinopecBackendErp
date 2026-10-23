// Regression tests for the plant-floor fixes: dispatch rows vs invoices,
// closing a stage short, held material at delivery, phantom lots, waste units,
// job sheet visibility and the smaller floor rules.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
let orders;
let lots;
let template;
let serial = 0;

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  orders = db.collection('salesorders');
  lots = db.collection('inventoryitems');
  template = await orders.findOne({ status: { $in: ['in_production', 'production_planned'] } });
});
after(h.stopApp);

const ROUTES = {
  rollDispatch: 'roll_dispatch',
  rollPrintDispatch: 'roll_print_dispatch',
};

// A fresh order on the floor with one line, and its own raw lot of 1000 kg.
async function floorOrder({ route = ROUTES.rollDispatch, quantity = 1000, weight = '100 kg', status = 'production_planned', rawMaterial = 'FIXB film', remarks = '' } = {}) {
  serial += 1;
  const orderId = h.asId(new (require('mongoose').Types.ObjectId)());
  const itemId = h.asId(new (require('mongoose').Types.ObjectId)());
  const base = template.items[0];
  await orders.insertOne({
    ...template,
    _id: orderId,
    number: `FIXB-${Date.now()}-${serial}`,
    status,
    remarks,
    payments: [],
    paidAmount: 0,
    items: [
      {
        ...base,
        _id: itemId,
        productionRoute: route,
        quantity,
        unit: 'pcs',
        material: rawMaterial,
        manufacturing: { ...(base.manufacturing || {}), rawMaterial, requiredWeight: weight },
        currentStage: 'rolling',
        stagePickup: { stage: '', fromStage: '', lot: null, lotName: '', qty: 0, unit: '', pickedBy: null, pickedByName: '', pickedAt: null },
        stageWork: [],
      },
    ],
  });
  const { insertedId: lotId } = await lots.insertOne({
    category: 'raw',
    name: `FIXB raw ${serial}`,
    materialType: 'LDPE',
    unit: 'kg',
    quantity: 1000,
    unitPrice: 100,
    stage: null,
    notes: '',
    isActive: true,
    kind: 'catalog',
    wipStage: '',
    salesOrder: orderId,
    lineItem: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { orderId: String(orderId), itemId: String(itemId), lotId: String(lotId) };
}

const itemOf = async (o) => (await orders.findOne({ _id: h.asId(o.orderId) })).items.find((i) => String(i._id) === o.itemId);
const orderOf = (o) => orders.findOne({ _id: h.asId(o.orderId) });
const lotQty = async (id) => (await lots.findOne({ _id: h.asId(id) })).quantity;
const wipLot = (o, stage) => lots.findOne({ salesOrder: h.asId(o.orderId), kind: 'wip', category: 'output', wipStage: stage, quantity: { $gt: 0 } });
const rowsAt = async (o, stage) => (await itemOf(o)).stageWork.filter((r) => r.stage === stage);
const enter = (client, o, stage, body) => client.post('/api/production/enter', { orderId: o.orderId, itemId: o.itemId, stage, ...body });
const DISPATCH = { deliveryPartner: 'In-house', handoverPerson: 'Driver', vehicleNumber: 'RJ14 AB 1234' };

test('close stage short: a first stage under target lets the order finish', async () => {
  const o = await floorOrder({ route: ROUTES.rollPrintDispatch });
  let res = await enter(owner, o, 'rolling', { outputQty: 80, lotId: o.lotId });
  assert.equal(res.status, 200, res.data.message);
  const rollLot = await wipLot(o, 'rolling');
  res = await enter(owner, o, 'printing', { outputQty: 900, inputQty: 80, wasteQty: 2, lotId: String(rollLot._id) });
  assert.equal(res.status, 200, res.data.message);
  assert.equal((await itemOf(o)).currentStage, 'rolling', 'stuck on rolling before the fix');

  const rolling = await h.signIn('rolling');
  const close = { orderId: o.orderId, itemId: o.itemId, stage: 'rolling', reason: 'Granules ran out, customer agreed' };
  assert.equal((await rolling.post('/api/production/close-stage', close)).status, 403);
  assert.equal((await owner.post('/api/production/close-stage', { ...close, reason: '' })).status, 400);
  assert.equal((await owner.post('/api/production/close-stage', { ...close, stage: 'dispatch' })).status, 400);
  const production = await h.signIn('production');
  res = await production.post('/api/production/close-stage', close);
  assert.equal(res.status, 200, res.data.message);
  assert.equal((await owner.post('/api/production/close-stage', close)).status, 400, 'cannot close twice');

  const item = await itemOf(o);
  assert.equal(item.stageClosed.length, 1);
  assert.equal(item.stageClosed[0].stage, 'rolling');
  assert.match(item.stageClosed[0].reason, /customer agreed/);
  assert.equal(item.currentStage, 'dispatch', 'printing closed too: all rolling output used');

  // Waste at printing is kg of film, kept apart from pcs.
  const [printRow] = await rowsAt(o, 'printing');
  assert.equal(printRow.wasteUnit, 'kg');
  const reg = await owner.get(`/api/registers/order/${o.orderId}`);
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const printing = reg.data.data.stages.find((s) => s.id === 'printing');
  assert.equal(printing.lines[0].wasteUnit, 'kg');
  assert.equal(printing.lines[0].entries[0].wasteUnit, 'kg');
  const sheet = await owner.get(`/api/production/job-sheet/${o.orderId}?stage=printing`);
  const line = sheet.data.data.stages[0].lines[0];
  assert.equal(line.wasteUnit, 'kg');
  assert.equal(line.entries[0].wasteUnit, 'kg');
  assert.equal(line.wasteText, '2 kg');

  // Dispatch what printing made: the order is delivered.
  const printLot = await wipLot(o, 'printing');
  res = await enter(owner, o, 'dispatch', { outputQty: 900, lotId: String(printLot._id), ...DISPATCH });
  assert.equal(res.status, 200, res.data.message);
  assert.equal((await orderOf(o)).status, 'delivered');
});

test('dispatch rows on a delivered, invoiced order are protected', async () => {
  const o = await floorOrder({ route: ROUTES.rollDispatch, quantity: 1000, weight: '100 kg' });
  assert.equal((await enter(owner, o, 'rolling', { outputQty: 100, lotId: o.lotId })).status, 200);
  const rollLot = await wipLot(o, 'rolling');
  const res = await enter(owner, o, 'dispatch', { outputQty: 1000, inputQty: 100, lotId: String(rollLot._id), ...DISPATCH });
  assert.equal(res.status, 200, res.data.message);
  assert.equal((await orderOf(o)).status, 'delivered');
  const [row] = await rowsAt(o, 'dispatch');
  const entryId = String(row._id);

  const { insertedId: invoiceId } = await db.collection('invoices').insertOne({
    kind: 'sale',
    status: 'issued',
    number: `FIXB-INV-${serial}`,
    salesOrder: h.asId(o.orderId),
    lines: [{ itemId: h.asId(o.itemId), quantity: 600, unit: 'pcs' }],
    createdAt: new Date(),
  });

  const dispatch = await h.signIn('dispatch');
  let r = await dispatch.post('/api/production/entry/delete', { orderId: o.orderId, entryId });
  assert.equal(r.status, 403, 'dispatch:update alone cannot change a delivered order');
  r = await owner.post('/api/production/entry/delete', { orderId: o.orderId, entryId });
  assert.equal(r.status, 400, r.data.message);
  assert.match(r.data.message, /invoiced/);
  r = await owner.post('/api/production/entry/update', { orderId: o.orderId, entryId, outputQty: 500, inputQty: 50 });
  assert.equal(r.status, 400);
  r = await owner.post('/api/production/entry/update', { orderId: o.orderId, entryId, outputQty: 700, inputQty: 70 });
  assert.equal(r.status, 200, r.data.message);
  assert.equal((await rowsAt(o, 'dispatch'))[0].outputQty, 700);

  await db.collection('invoices').updateOne({ _id: invoiceId }, { $set: { status: 'cancelled' } });
  r = await owner.post('/api/production/entry/delete', { orderId: o.orderId, entryId });
  assert.equal(r.status, 200, r.data.message);
});

test('editing a dispatch row checks the kg against the pieces', async () => {
  const o = await floorOrder({ route: ROUTES.rollDispatch, quantity: 1000, weight: '100 kg' });
  assert.equal((await enter(owner, o, 'rolling', { outputQty: 100, lotId: o.lotId })).status, 200);
  const rollLot = await wipLot(o, 'rolling');
  const dispatch = await h.signIn('dispatch');
  let r = await enter(dispatch, o, 'dispatch', { outputQty: 100, inputQty: 10, lotId: String(rollLot._id), ...DISPATCH });
  assert.equal(r.status, 200, r.data.message);
  const [row] = await rowsAt(o, 'dispatch');
  r = await dispatch.post('/api/production/entry/update', { orderId: o.orderId, entryId: String(row._id), inputQty: 60 });
  assert.equal(r.status, 400);
  assert.match(r.data.message, /should weigh about/);
});

test('material still held when an order is delivered goes back to its lot', async () => {
  const o = await floorOrder({ route: ROUTES.rollDispatch, quantity: 1000, weight: '100 kg' });
  let r = await owner.post('/api/production/pickup', { orderId: o.orderId, itemId: o.itemId, stage: 'rolling', lotId: o.lotId, qty: 120 });
  assert.equal(r.status, 200, r.data.message);
  r = await owner.post('/api/production/complete', { orderId: o.orderId, itemId: o.itemId, stage: 'rolling', inputQty: 100, outputQty: 100, wasteQty: 0 });
  assert.equal(r.status, 200, r.data.message);
  assert.equal((await itemOf(o)).stagePickup.qty, 20, '20 kg still held at rolling');
  const rollLot = await wipLot(o, 'rolling');
  r = await enter(owner, o, 'dispatch', { outputQty: 1000, inputQty: 100, lotId: String(rollLot._id), ...DISPATCH });
  assert.equal(r.status, 200, r.data.message);
  const order = await orderOf(o);
  assert.equal(order.status, 'delivered');
  assert.equal(order.items[0].stagePickup.qty, 0);
  assert.equal(await lotQty(o.lotId), 900, 'only the 100 kg used is gone');
});

test('a rejected entry leaves no output or waste lots behind', async () => {
  const o = await floorOrder();
  const before = await lots.countDocuments({ salesOrder: h.asId(o.orderId), kind: 'wip' });
  const r = await enter(owner, o, 'rolling', { outputQty: 50, wasteQty: 1, lotId: o.lotId, details: { gross: '10', net: '20' } });
  assert.equal(r.status, 400);
  assert.equal(await lots.countDocuments({ salesOrder: h.asId(o.orderId), kind: 'wip' }), before);
  assert.equal(await lotQty(o.lotId), 1000);
});

test('job sheets follow the floor queue and hide remarks from operators', async () => {
  const approved = await floorOrder({ status: 'approved', remarks: 'Price talk: secret' });
  const rolling = await h.signIn('rolling');
  assert.equal((await rolling.get(`/api/production/job-sheet/${approved.orderId}`)).status, 404);
  assert.equal((await owner.get(`/api/production/job-sheet/${approved.orderId}`)).status, 200);
  for (const status of ['submitted', 'cancelled']) {
    await orders.updateOne({ _id: h.asId(approved.orderId) }, { $set: { status } });
    assert.equal((await rolling.get(`/api/production/job-sheet/${approved.orderId}`)).status, 404, status);
  }
  await orders.updateOne({ _id: h.asId(approved.orderId) }, { $set: { status: 'approved' } });
  const list = await owner.get('/api/production/stage-sheet/rolling');
  assert.ok(!list.data.data.lines.some((l) => l.orderId === approved.orderId), 'approved, unplanned order is not on the work list');

  const live = await floorOrder({ remarks: 'Price talk: secret' });
  const sheet = await rolling.get(`/api/production/job-sheet/${live.orderId}`);
  assert.equal(sheet.status, 200);
  assert.equal(sheet.data.data.order.remarks, '');
  assert.equal((await owner.get(`/api/production/job-sheet/${live.orderId}`)).data.data.order.remarks, 'Price talk: secret');
});

test('a line with no raw material is offered only its own lots', async () => {
  const o = await floorOrder({ rawMaterial: '' });
  const order = await orderOf(o);
  const offered = await require('../src/modules/production/production.service').sourceLots(order, order.items[0], 'rolling');
  assert.deepEqual(offered.map((l) => l.id), [o.lotId]);
});

test('a lot used on the floor keeps its unit and category', async () => {
  const o = await floorOrder();
  assert.equal((await enter(owner, o, 'rolling', { outputQty: 10, lotId: o.lotId })).status, 200);
  let r = await owner.patch(`/api/inventory/items/${o.lotId}`, { unit: 'pcs' });
  assert.equal(r.status, 400, JSON.stringify(r.data));
  r = await owner.patch(`/api/inventory/items/${o.lotId}`, { category: 'waste' });
  assert.equal(r.status, 400);
  r = await owner.patch(`/api/inventory/items/${o.lotId}`, { notes: 'still editable' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
});

test('only the holder or a manager returns a held lot', async () => {
  const o = await floorOrder();
  const body = { orderId: o.orderId, itemId: o.itemId, stage: 'rolling' };
  assert.equal((await owner.post('/api/production/pickup', { ...body, lotId: o.lotId, qty: 5 })).status, 200);
  const rolling = await h.signIn('rolling');
  assert.equal((await rolling.post('/api/production/release', body)).status, 403);
  const production = await h.signIn('production');
  const r = await production.post('/api/production/release', body);
  assert.equal(r.status, 200, r.data.message);
  assert.equal(await lotQty(o.lotId), 1000);
});

test('work cannot be dated in the future', async () => {
  const o = await floorOrder();
  const later = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
  const r = await enter(owner, o, 'rolling', { outputQty: 10, lotId: o.lotId, workDate: later });
  assert.equal(r.status, 400);
  assert.match(r.data.message, /future/);
  assert.equal(await lotQty(o.lotId), 1000);
  assert.equal((await enter(owner, o, 'rolling', { outputQty: 10, lotId: o.lotId, workDate: new Date().toISOString() })).status, 200);
});
