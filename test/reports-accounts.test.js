const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
let invoice;
let customerId;
const period = 'from=2026-04-01&to=2026-10-31';
const report = async (c = owner, q = period) => c.get(`/api/reports/accounts?${q}`);

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5', invoicePrefix: 'SP' });
  const order = await db.collection('salesorders').findOne({ status: { $in: ['dispatched', 'delivered', 'completed'] }, 'items.stageWork.stage': 'dispatch' });
  customerId = String(order.customer);
  const draft = (await owner.get(`/api/billing/orders/${order._id}/invoice-draft`)).data.data;
  const line = draft.lines.find((l) => l.suggested > 0);
  const res = await owner.post(`/api/billing/orders/${order._id}/invoices`, { invoiceDate: '2026-09-15', lines: [{ itemId: line.itemId, quantity: line.suggested }] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  invoice = res.data.data;
  await owner.post(`/api/billing/customers/${customerId}/receipts`, { amount: 1000, receivedAt: '2026-10-05', method: 'upi' });
});
after(h.stopApp);

test('accounts report: billed, GST split and collections add up for the period', async () => {
  const res = await report();
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const r = res.data.data;
  const issued = await db.collection('invoices').find({ kind: 'sale', status: 'issued' }).toArray();
  const expected = Math.round(issued.reduce((s, i) => s + i.total, 0) * 100) / 100;
  assert.equal(r.kpis.billed, expected);
  assert.equal(r.kpis.invoices, issued.length);
  const sept = r.monthly.find((m) => m.month === '2026-09');
  assert.ok(sept.billed >= invoice.total);
  assert.equal(r.monthly.length, 7, 'April to October');
  assert.ok(r.monthly.reduce((s, m) => s + m.billed, 0) - r.kpis.billed < 0.01);
  // The UPI receipt is in the collections, by method too.
  assert.ok(r.receiptRegister.some((c) => c.method === 'upi' && c.amount === 1000));
  assert.ok(r.collectionsByMethod.find((m) => m.method === 'upi').amount >= 1000);
  assert.ok(r.kpis.collected >= 1000);
});

test('GST tables: every issued invoice lands in B2B or B2C, and HSN totals match the invoices', async () => {
  const r = (await report()).data.data;
  const { gst } = r;
  const inTables = new Set([...gst.b2b.map((x) => x.number), ...gst.b2cl.map((x) => x.number)]);
  const b2csTaxable = gst.b2cs.reduce((s, x) => s + x.taxable, 0);
  const b2bTaxable = gst.totals.b2b.taxable + gst.totals.b2cl.taxable;
  assert.ok(Math.abs(b2bTaxable + b2csTaxable - r.kpis.taxable) < 0.05, 'B2B + B2C taxable = all taxable');
  assert.ok(Math.abs(gst.totals.hsn.taxable - r.kpis.taxable) < 0.05, 'HSN taxable = all taxable');
  const tax = gst.totals.hsn.igst + gst.totals.hsn.cgst + gst.totals.hsn.sgst;
  assert.ok(Math.abs(tax - r.kpis.tax) < 0.05, 'HSN tax = all tax');
  if (invoice.buyer.gstin) assert.ok(inTables.has(invoice.number), 'registered buyer goes to B2B');
  for (const line of invoice.lines) assert.ok(gst.hsn.some((x) => x.hsn === (line.hsnCode || 'Not set')));
});

test('a cancelled invoice leaves the totals and stays on the register marked cancelled', async () => {
  const before = (await report()).data.data;
  const cancel = await owner.post(`/api/billing/invoices/${invoice.id}/cancel`, { reason: 'Wrong rate' });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  const after = (await report()).data.data;
  assert.ok(Math.abs(before.kpis.billed - invoice.total - after.kpis.billed) < 0.01);
  assert.equal(after.kpis.cancelledInvoices, before.kpis.cancelledInvoices + 1);
  assert.equal(after.invoiceRegister.find((x) => x.number === invoice.number).status, 'cancelled');
  assert.ok(Math.abs(before.gst.totals.hsn.taxable - invoice.taxable - after.gst.totals.hsn.taxable) < 0.05);
});

test('only Accounts and the owner can see it; bad periods are refused', async () => {
  const accounts = await h.signIn('accounts');
  assert.equal((await report(accounts)).status, 200);
  const production = await h.signIn('production');
  assert.equal((await report(production)).status, 403);
  assert.equal((await report(owner, 'from=2026-10-10&to=2026-10-01')).status, 400);
  assert.equal((await report(owner, 'from=2020-01-01&to=2026-10-01')).status, 400);
  const fy = (await report(owner, '')).data.data;
  assert.match(fy.from, /^\d{4}-04-01$/, 'defaults to this financial year');
});
