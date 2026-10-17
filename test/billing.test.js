const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
let order;
before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  // An order with goods already sent out on the dispatch register.
  order = await db.collection('salesorders').findOne({ status: { $in: ['dispatched', 'delivered', 'completed'] }, 'items.stageWork.stage': 'dispatch' });
});
after(h.stopApp);

const draftOf = async (c) => (await c.get(`/api/billing/orders/${order._id}/invoice-draft`)).data.data;

test('no invoices until the company GSTIN is set', async () => {
  const draft = await draftOf(owner);
  const line = draft.lines.find((l) => l.suggested > 0);
  assert.ok(line, 'a dispatched line to bill');
  const res = await owner.post(`/api/billing/orders/${order._id}/invoices`, { lines: [{ itemId: line.itemId, quantity: 1 }] });
  assert.equal(res.status, 400);
  assert.match(res.data.message, /GSTIN/);
});

test('invoice from dispatched quantity: number series, GST split by state, rounded total, no over-billing', async () => {
  assert.equal((await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5', invoicePrefix: 'SP' })).status, 200);
  const draft = await draftOf(owner);
  const line = draft.lines.find((l) => l.suggested > 0);
  const res = await owner.post(`/api/billing/orders/${order._id}/invoices`, { invoiceDate: '2026-10-10', lines: [{ itemId: line.itemId, quantity: line.suggested }] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const inv = res.data.data;
  assert.equal(inv.number, 'SP/26-27/0001');
  const buyerState = draft.buyer.stateCode;
  if (buyerState && buyerState !== '07') {
    assert.equal(inv.intraState, false);
    assert.equal(inv.cgst, 0);
    assert.ok(inv.igst >= 0);
  } else {
    assert.equal(inv.igst, 0);
  }
  assert.equal(inv.total, Math.round(inv.taxable + inv.cgst + inv.sgst + inv.igst));
  assert.ok(Math.abs(inv.roundOff) < 0.5);
  assert.equal(inv.seller.gstin, '07AAAAA1111A1Z5', 'seller details kept on the invoice');
  const left = line.available - line.suggested;
  const over = await owner.post(`/api/billing/orders/${order._id}/invoices`, { lines: [{ itemId: line.itemId, quantity: left + 1 }] });
  assert.equal(over.status, 400);
  const again = await draftOf(owner);
  assert.equal(again.lines.find((l) => l.itemId === line.itemId).invoiced, line.suggested);
  assert.equal((await owner.post(`/api/billing/orders/${order._id}/invoices`, { invoiceDate: '2099-01-01', lines: [{ itemId: line.itemId, quantity: 0.001 }] })).status, 400, 'no future dates');
});

test('draft and submitted orders cannot be invoiced', async () => {
  const draftOrder = await db.collection('salesorders').findOne({ status: 'draft' });
  const res = await owner.post(`/api/billing/orders/${draftOrder._id}/invoices`, { lines: [{ itemId: String(draftOrder.items[0]._id), quantity: 1 }] });
  assert.equal(res.status, 400);
});

test('ledger: opening bills, order payments and receipts settle the oldest bills first', async () => {
  const customerId = String(order.customer);
  const opening = await owner.post(`/api/billing/customers/${customerId}/openings`, { number: 'OLD-101', date: '2026-03-01', amount: 1000, dueDate: '2026-03-31' });
  assert.equal(opening.status, 201, JSON.stringify(opening.data));
  assert.equal((await owner.post(`/api/billing/customers/${customerId}/openings`, { number: 'OLD-101', date: '2026-03-01', amount: 5 })).status, 409, 'same bill twice');

  const before = (await owner.get(`/api/billing/customers/${customerId}/ledger`)).data.data;
  const old = before.invoices.find((i) => i.number === 'OLD-101');
  assert.equal(old.payState, 'unpaid');
  assert.ok(old.overdueDays > 0);
  assert.ok(before.summary.overdue >= 1000);

  const receipt = await owner.post(`/api/billing/customers/${customerId}/receipts`, { amount: 600, method: 'upi', reference: 'UTR1' });
  assert.equal(receipt.status, 201, JSON.stringify(receipt.data));
  const mid = (await owner.get(`/api/billing/customers/${customerId}/ledger`)).data.data;
  assert.equal(mid.invoices.find((i) => i.number === 'OLD-101').paid, 600, 'oldest due bill paid first');
  assert.equal(mid.invoices.find((i) => i.number === 'OLD-101').payState, 'partly_paid');
  const last = mid.entries.at(-1);
  assert.equal(last.balance, mid.summary.net);
  assert.ok(Math.abs(mid.summary.net - (mid.summary.billed - mid.summary.received)) < 0.01);

  assert.equal((await owner.post(`/api/billing/receipts/${receipt.data.data.id}/void`, {})).status, 400, 'reason needed');
  assert.equal((await owner.post(`/api/billing/receipts/${receipt.data.data.id}/void`, { reason: 'bounced' })).status, 200);
  const after = (await owner.get(`/api/billing/customers/${customerId}/ledger`)).data.data;
  assert.equal(after.invoices.find((i) => i.number === 'OLD-101').paid, 0, 'void undoes the payment');
});

test('cancelled invoices drop out of the account and the quantity can be billed again', async () => {
  const list = (await owner.get(`/api/billing/invoices?order=${order._id}`)).data.data;
  const inv = list.find((i) => i.status === 'issued');
  assert.equal((await owner.post(`/api/billing/invoices/${inv.id}/cancel`, {})).status, 400);
  assert.equal((await owner.post(`/api/billing/invoices/${inv.id}/cancel`, { reason: 'wrong rate' })).status, 200);
  const ledger = (await owner.get(`/api/billing/customers/${order.customer}/ledger`)).data.data;
  assert.ok(!ledger.invoices.some((i) => i.id === inv.id));
  const draft = await draftOf(owner);
  assert.ok(draft.lines.every((l) => l.invoiced === 0));
  const next = await owner.post(`/api/billing/orders/${order._id}/invoices`, { lines: [{ itemId: draft.lines[0].itemId, quantity: 1 }] });
  assert.equal(next.status, 201);
  assert.equal(next.data.data.number, 'SP/26-27/0002', 'cancelled numbers are not reused');
});

test('opening balances import: preview with errors, then apply', async () => {
  const c = await db.collection('customers').findOne({});
  const rows = [
    { customer: c.code, number: 'IMP-1', date: '2026-04-01', amount: '2500' },
    { customer: 'NO SUCH CUSTOMER', number: 'IMP-2', date: '2026-04-01', amount: '10' },
  ];
  const preview = (await owner.post('/api/billing/openings/import', { rows, apply: true })).data.data;
  assert.equal(preview.applied, false, 'nothing applied while a row is wrong');
  assert.equal(preview.errors, 1);
  const good = (await owner.post('/api/billing/openings/import', { rows: rows.slice(0, 1), apply: true })).data.data;
  assert.equal(good.applied, true);
  assert.equal(good.added, 1);
});

test('who may do what', async () => {
  const production = await h.signIn('production');
  assert.equal((await production.get(`/api/billing/customers/${order.customer}/ledger`)).status, 403);
  const sales = await h.signIn('sales');
  assert.equal((await sales.get(`/api/billing/customers/${order.customer}/ledger`)).status, 200);
  const inv = (await owner.get(`/api/billing/invoices?order=${order._id}`)).data.data.find((i) => i.status === 'issued');
  assert.equal((await sales.post(`/api/billing/invoices/${inv.id}/cancel`, { reason: 'x' })).status, 403, 'only Accounts / owner cancel');
  const accounts = await h.signIn('accounts');
  assert.equal((await accounts.post(`/api/billing/customers/${order.customer}/receipts`, { amount: 1 })).status, 201);
});
