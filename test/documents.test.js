const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Document layouts (Settings → Documents), order charges and the values
// printed on an order's documents.

let db;
let owner;
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5' });
  await owner.put('/api/books/settings', { startDate: '2026-04-01' });
});

after(async () => {
  await h.stopApp();
});

test('layouts: rename, hide, reorder and add fields; reset brings the default back', async () => {
  const list = (await owner.get('/api/document-layouts')).data.data;
  assert.ok(list.some((l) => l.id === 'salesOrder') && list.some((l) => l.id === 'tableExport'));

  const res = await owner.put('/api/document-layouts/salesOrder', {
    title: 'ORDER CONFIRMATION',
    fields: [
      { key: 'orderDate', label: 'Date', show: true },
      { key: 'voucherNo', label: 'Order no.', show: false },
      { custom: true, label: 'Brand', source: 'order' },
      { custom: true, label: 'Declaration', source: 'fixed', text: 'Goods for packing only.' },
    ],
    columns: [{ key: 'per', show: false }],
  });
  assert.equal(res.status, 200, res.data.message);
  const layout = res.data.data;
  assert.equal(layout.title, 'ORDER CONFIRMATION');
  assert.deepEqual(layout.fields.slice(0, 2).map((f) => [f.key, f.label, f.show]), [['orderDate', 'Date', true], ['voucherNo', 'Order no.', false]]);
  const brand = layout.fields.find((f) => f.label === 'Brand');
  assert.match(brand.key, /^c_/);
  assert.equal(layout.columns.find((c) => c.key === 'per').show, false);
  assert.ok(layout.fields.some((f) => f.key === 'destination'), 'fields not sent stay, at the end');

  const orderFields = (await owner.get('/api/document-layouts/order-fields')).data.data;
  assert.ok(orderFields.some((f) => f.key === brand.key && f.label === 'Brand'));
  assert.ok(orderFields.some((f) => f.key === 'dispatchedThrough'));

  // Fixed text only on documents not made from an order.
  assert.equal((await owner.put('/api/document-layouts/customerStatement', { fields: [{ custom: true, label: 'X', source: 'order' }] })).status, 400);
  assert.equal((await owner.put('/api/document-layouts/stageSheet', { columns: [] })).status, 200);
  assert.equal((await owner.put('/api/document-layouts/stageSheet', { columns: [{ key: 'sl', show: false }, ...['order', 'priority', 'deliverBy', 'customer', 'product', 'toMake', 'done', 'left', 'doneToday', 'machine', 'sign'].map((key) => ({ key, show: false }))] })).status, 400);

  const sales = await h.signIn('sales');
  assert.equal((await sales.get('/api/document-layouts/salesOrder')).status, 200, 'every print page can read it');
  assert.equal((await sales.put('/api/document-layouts/salesOrder', { title: 'X' })).status, 403);

  const reset = (await owner.del('/api/document-layouts/salesOrder')).data.data;
  assert.equal(reset.title, 'SALES ORDER');
  assert.equal(reset.changed, false);
  assert.ok(!reset.fields.some((f) => f.custom));
});

test('order charges add to the total with their GST; document values are kept', async () => {
  const source = await db.collection('salesorders').findOne({ status: 'approved', orderType: 'sales_order' });
  const items = source.items.map(({ _id, stageWork, currentStage, stagePickup, ...rest }) => ({ ...rest, quantity: 100, rate: 10, discount: 0, taxPercent: 18 }));
  const res = await owner.post('/api/sales-orders', {
    customerId: String(source.customer),
    orderDate: today,
    items: items.slice(0, 1),
    charges: [{ name: 'Outward Freight Charges by Road', sac: '996511', amount: 500, gstPercent: 18 }, { name: '', amount: 0 }],
    documentFields: { dispatchedThrough: 'VRL Logistics', destination: 'Tiruppur', junk: 'dropped' },
  });
  assert.equal(res.status, 201, res.data.message);
  const order = res.data.data;
  assert.equal(order.charges.length, 1, 'blank charge rows are dropped');
  assert.equal(order.subtotal, 1000);
  assert.equal(order.tax, 270);
  assert.equal(order.grandTotal, 1770);
  assert.deepEqual(order.documentFields, { dispatchedThrough: 'VRL Logistics', destination: 'Tiruppur' });
  assert.equal((await owner.patch(`/api/sales-orders/${order.id}`, { charges: [{ name: 'Freight', amount: -5 }] })).status, 400);
});

test('a charge goes on one invoice only, with the order values', async () => {
  const order = await db.collection('salesorders').findOne({ status: { $in: ['dispatched', 'delivered', 'completed'] }, 'items.stageWork.stage': 'dispatch' });
  const chargeId = new (require('mongoose').Types.ObjectId)();
  await db.collection('salesorders').updateOne(
    { _id: order._id },
    { $set: { charges: [{ _id: chargeId, name: 'Outward Freight', sac: '996511', amount: 500, gstPercent: 18 }], documentFields: { dispatchedThrough: 'By road' } } }
  );
  const draft = (await owner.get(`/api/billing/orders/${order._id}/invoice-draft`)).data.data;
  assert.deepEqual(draft.charges.map((c) => [c.name, c.billed]), [['Outward Freight', false]]);
  const line = draft.lines.find((l) => l.available > 0) || draft.lines[0];
  const qty = Math.min(1, line.available) || line.available;
  const first = await owner.post(`/api/billing/orders/${order._id}/invoices`, { invoiceDate: today, lines: [{ itemId: line.itemId, quantity: qty }] });
  assert.equal(first.status, 201, first.data.message);
  const charge = first.data.data.lines.find((l) => l.chargeId);
  assert.equal(charge.product, 'Outward Freight');
  assert.equal(charge.hsnCode, '996511');
  assert.equal(charge.taxable, 500);
  assert.equal(first.data.data.documentFields.dispatchedThrough, 'By road');
  const again = (await owner.get(`/api/billing/orders/${order._id}/invoice-draft`)).data.data;
  assert.equal(again.charges[0].billed, true);
  const left = again.lines.find((l) => l.available > 0);
  if (left) {
    const second = (await owner.post(`/api/billing/orders/${order._id}/invoices`, { invoiceDate: today, lines: [{ itemId: left.itemId, quantity: left.available }] })).data.data;
    assert.ok(!second.lines.some((l) => l.chargeId), 'not billed twice');
  }
});
