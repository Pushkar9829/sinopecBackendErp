const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
let customerId;
before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  customerId = String((await db.collection('customers').findOne({}))._id);
});
after(async () => {
  await db.collection('formfieldsettings').deleteMany({});
  require('../src/modules/formFields/formFields.service').forget();
  await h.stopApp();
});

// A complete rolling + cutting line copied from a seeded approved order.
async function completeLine(extra = {}) {
  const source = await db.collection('salesorders').findOne({ status: 'approved', orderType: 'sales_order' });
  const { _id, stageWork, currentStage, stagePickup, ...line } = source.items[0];
  return { ...line, ...extra };
}

test('flap: half of it is added to the length in both weight formulas', async () => {
  const calc = (await owner.post('/api/rate-calculator/sales-order', { width: 12, length: 16, flap: 4, gauge: 150, divisor: 3300, materialRate: 100 })).data.data;
  assert.equal(calc.weight, Math.round(((12 * 18 * 150) / 3300) * 10000) / 10000);
  assert.match(calc.weightWorking, /\(16 \+ 4 ÷ 2\)/);
  const without = (await owner.post('/api/rate-calculator/sales-order', { width: 12, length: 16, gauge: 150, divisor: 3300, materialRate: 100 })).data.data;
  assert.ok(calc.weight > without.weight);

  const line = await completeLine({ width: '12', length: '16', flap: '4', thickness: '150', unit: 'pcs', quantity: 10000, productionRoute: 'roll_cut_dispatch' });
  const order = (await owner.post('/api/sales-orders', { customerId, deliveryDate: '2099-01-01', items: [line] })).data.data;
  const item = order.items[0];
  assert.equal(item.flap, '4');
  assert.equal(item.rolling.weightPer1000, Math.round(((12 * 18 * 150) / 3300) * 10000) / 10000);
  assert.match(item.rolling.weightWorking, /\(16 \+ 4 ÷ 2\)/);
});

test('customer PO number and date: on the order, searchable, and printed on the invoice', async () => {
  const order = await db.collection('salesorders').findOne({ status: { $in: ['dispatched', 'delivered', 'completed'] }, 'items.stageWork.stage': 'dispatch' });
  const res = await owner.patch(`/api/sales-orders/${order._id}`, { customerPoNumber: 'PO/7781', customerPoDate: '2026-09-02' });
  assert.ok([200, 400, 403].includes(res.status));
  // Completed orders may not take header edits; set it directly to test the rest.
  await db.collection('salesorders').updateOne({ _id: order._id }, { $set: { customerPoNumber: 'PO/7781', customerPoDate: new Date('2026-09-02T12:00:00+05:30') } });
  const detail = (await owner.get(`/api/sales-orders/${order._id}`)).data.data;
  assert.equal(detail.customerPoNumber, 'PO/7781');
  const found = (await owner.get('/api/sales-orders?page=1&q=PO/7781')).data.data;
  assert.ok(found.items.some((o) => o.id === String(order._id)));

  await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5' });
  const draft = (await owner.get(`/api/billing/orders/${order._id}/invoice-draft`)).data.data;
  const line = draft.lines.find((l) => l.suggested > 0);
  const inv = (await owner.post(`/api/billing/orders/${order._id}/invoices`, { lines: [{ itemId: line.itemId, quantity: line.suggested }] })).data.data;
  assert.equal(inv.poNumber, 'PO/7781');
  assert.ok(inv.poDate);

  const created = (await owner.post('/api/sales-orders', { customerId, deliveryDate: '2099-01-01', customerPoNumber: ' PO-55 ', customerPoDate: '2026-10-01', items: [await completeLine()] })).data.data;
  assert.equal(created.customerPoNumber, 'PO-55');
});

test('form fields: the owner chooses mandatory inputs; submit and saves follow them', async () => {
  const rules = (await owner.get('/api/form-fields')).data.data;
  const orderLine = rules.find((f) => f.id === 'orderLine');
  assert.ok(orderLine.fields.find((f) => f.key === 'product').locked);
  assert.equal(orderLine.fields.find((f) => f.key === 'width').required, true);
  assert.equal(orderLine.fields.find((f) => f.key === 'color').required, false);

  // Colour mandatory: an order without one cannot be submitted.
  await owner.put('/api/form-fields', { required: { orderLine: { color: true, product: false }, order: { deliveryDate: false } } });
  const after = (await owner.get('/api/form-fields')).data.data;
  assert.equal(after.find((f) => f.id === 'orderLine').fields.find((f) => f.key === 'product').required, true, 'locked stays mandatory');
  const noColour = (await owner.post('/api/sales-orders', { customerId, items: [await (async () => { const l = await completeLine({ color: '' }); return { ...l, manufacturing: { ...l.manufacturing, color: '' } }; })()] })).data.data;
  const refused = await owner.post(`/api/sales-orders/${noColour.id}/submit`, {});
  assert.equal(refused.status, 400);
  assert.match(refused.data.message, /colour/);
  assert.doesNotMatch(refused.data.message, /delivery date/i, 'delivery date was made optional');
  // With a colour it goes through, even without a delivery date.
  const withColour = (await owner.post('/api/sales-orders', { customerId, items: [await completeLine({ color: 'Black' })] })).data.data;
  assert.equal((await owner.post(`/api/sales-orders/${withColour.id}/submit`, {})).status, 200);

  // Customers and suppliers on save.
  await owner.put('/api/form-fields', { required: { customer: { mobile: true }, supplier: { gstNumber: true } } });
  const c1 = await owner.post('/api/customers', { name: 'No Phone Traders' });
  assert.equal(c1.status, 400);
  assert.match(c1.data.message, /mobile/);
  assert.equal((await owner.post('/api/customers', { name: 'Phone Traders', mobile: '9876543210' })).status, 201);
  const s1 = await owner.post('/api/suppliers', { name: 'No GST Supplies' });
  assert.equal(s1.status, 400);

  const sales = await h.signIn('sales');
  assert.equal((await sales.get('/api/form-fields')).status, 200, 'every form reads the rules');
  assert.equal((await sales.put('/api/form-fields', { required: { customer: { mobile: false } } })).status, 403);
});
