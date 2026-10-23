const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Regression tests for the money and orders review: billing follows dispatch,
// billed orders stay fixed, deposit accounts are kept, buyer state, start
// date, purchases, GSTR-3B, invoice number length.

let db;
let owner;
let accounts;
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;
const named = (name) => accounts.find((a) => a.name === name);
const keyed = (key) => accounts.find((a) => a.key === key);
const voucherOf = (sourceKey) => db.collection('vouchers').findOne({ sourceKey });
const sync = () => owner.get('/api/books/accounts');

async function completeLines() {
  const source = await db.collection('salesorders').findOne({ status: 'approved', orderType: 'sales_order' });
  return source.items.map(({ _id, stageWork, currentStage, stagePickup, ...rest }) => rest);
}

// A new customer with an approved (not yet dispatched) order.
async function approvedOrder(customerBody = {}, orderBody = {}) {
  const customer = (await owner.post('/api/customers', { name: `Money Test ${Math.random().toString(36).slice(2, 8)}`, ...customerBody })).data.data;
  const created = await owner.post('/api/sales-orders', { customerId: customer.id, deliveryDate: '2099-01-01', items: await completeLines(), ...orderBody });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.data.id;
  assert.equal((await owner.post(`/api/sales-orders/${id}/submit`)).status, 200);
  const approved = await owner.post(`/api/sales-orders/${id}/approve`, { creditOverrideReason: 'test' });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  return { customer, order: approved.data.data };
}

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  assert.equal((await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5', invoicePrefix: 'SP' })).status, 200);
  await owner.put('/api/books/settings', { startDate: '2026-04-01' });
  accounts = (await owner.get('/api/books/accounts')).data.data;
});
after(h.stopApp);

test('billing follows dispatch; only the owner bills ahead, with a reason kept on the invoice', async () => {
  const { order } = await approvedOrder();
  const draft = (await owner.get(`/api/billing/orders/${order.id}/invoice-draft`)).data.data;
  const line = draft.lines[0];
  assert.equal(line.available, 0, 'nothing dispatched yet');
  assert.ok(line.aheadAvailable > 0);
  assert.equal(draft.canBillAhead, true);

  const body = { invoiceDate: today, lines: [{ itemId: line.itemId, quantity: 1 }] };
  const normal = await owner.post(`/api/billing/orders/${order.id}/invoices`, body);
  assert.equal(normal.status, 400);
  assert.match(normal.data.message, /dispatched/);

  const accountsUser = await h.signIn('accounts');
  assert.equal((await accountsUser.get(`/api/billing/orders/${order.id}/invoice-draft`)).data.data.canBillAhead, false);
  assert.equal((await accountsUser.post(`/api/billing/orders/${order.id}/invoices`, { ...body, billAhead: true, billAheadReason: 'held at plant' })).status, 403);
  assert.equal((await owner.post(`/api/billing/orders/${order.id}/invoices`, { ...body, billAhead: true, billAheadReason: 'x' })).status, 400, 'reason needed');

  const ahead = await owner.post(`/api/billing/orders/${order.id}/invoices`, { ...body, billAhead: true, billAheadReason: 'Goods held at plant for the customer' });
  assert.equal(ahead.status, 201, JSON.stringify(ahead.data));
  assert.equal(ahead.data.data.billAhead, true);
  assert.equal(ahead.data.data.billAheadReason, 'Goods held at plant for the customer');
});

test('an order with an issued invoice cannot be cancelled, sent back to draft or deleted', async () => {
  const { order } = await approvedOrder();
  const line = order.items[0];
  const inv = await owner.post(`/api/billing/orders/${order.id}/invoices`, { invoiceDate: today, billAhead: true, billAheadReason: 'advance billing', lines: [{ itemId: line.id, quantity: 1 }] });
  assert.equal(inv.status, 201, JSON.stringify(inv.data));

  const cancel = await owner.post(`/api/sales-orders/${order.id}/cancel`, { reason: 'changed mind' });
  assert.equal(cancel.status, 400);
  assert.match(cancel.data.message, /issued invoice/);
  const back = await owner.post(`/api/sales-orders/${order.id}/return`, { reason: 'edit prices' });
  assert.equal(back.status, 400);
  assert.match(back.data.message, /issued invoice/);

  assert.equal((await owner.post(`/api/billing/invoices/${inv.data.data.id}/cancel`, { reason: 'wrong bill' })).status, 200);
  assert.equal((await owner.post(`/api/sales-orders/${order.id}/return`, { reason: 'edit prices' })).status, 200, 'free again once the invoice is cancelled');
});

test('the invoice preview figures include line and order discounts and match the issued invoice', async () => {
  const { order } = await approvedOrder({}, { discount: 137 });
  const raw = await db.collection('salesorders').findOne({ _id: h.asId(order.id) });
  await db.collection('salesorders').updateOne({ _id: raw._id }, { $set: { 'items.0.discount': 55 } });
  const draft = (await owner.get(`/api/billing/orders/${order.id}/invoice-draft`)).data.data;
  const line = draft.lines[0];
  assert.ok(line.discount > 55, 'line discount plus a share of the order discount');
  assert.ok(line.netRate < line.rate);

  // What the screen works out (OrderInvoices.jsx preview).
  const quantity = Math.min(3, line.aheadAvailable);
  const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const taxable = money(Math.max(0, quantity * line.rate - money((line.discount * quantity) / line.ordered)));
  const tax = (taxable * line.gstPercent) / 100;
  const parts = draft.intraState ? money(tax / 2) * 2 : money(tax);
  const previewTotal = Math.round(taxable + parts);

  const res = await owner.post(`/api/billing/orders/${order.id}/invoices`, { invoiceDate: today, billAhead: true, billAheadReason: 'preview check', lines: [{ itemId: line.itemId, quantity }] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.data.taxable, taxable);
  assert.equal(res.data.data.total, previewTotal);
});

test('a customer without GSTIN in another state is billed IGST, with that place of supply', async () => {
  assert.equal((await owner.post('/api/customers', { name: 'Bad State Co', stateCode: '99' })).status, 400);
  const { customer, order } = await approvedOrder({ stateCode: '27' });
  assert.equal(customer.stateCode, '27');
  const res = await owner.post(`/api/billing/orders/${order.id}/invoices`, { invoiceDate: today, billAhead: true, billAheadReason: 'state test', lines: [{ itemId: order.items[0].id, quantity: 1 }] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.data.intraState, false);
  assert.equal(res.data.data.placeOfSupply, '27');
  assert.equal(res.data.data.cgst, 0);
});

test('payments keep the account they went into; a new default bank does not move them', async () => {
  const { customer } = await approvedOrder();
  const options = (await owner.get('/api/billing/deposit-accounts')).data.data;
  const oldBank = options.defaultBank;
  assert.ok(oldBank && options.cash);
  const second = await owner.post('/api/bank/accounts', { name: 'Second Bank A/c', group: 'bank' });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  const secondId = second.data.data.id;

  const plain = (await owner.post(`/api/billing/customers/${customer.id}/receipts`, { amount: 100, method: 'upi' })).data.data;
  assert.equal(String(plain.depositTo), oldBank);
  const chosen = (await owner.post(`/api/billing/customers/${customer.id}/receipts`, { amount: 50, method: 'upi', depositTo: secondId })).data.data;
  assert.equal(String(chosen.depositTo), secondId);
  assert.equal((await owner.post(`/api/billing/customers/${customer.id}/receipts`, { amount: 5, depositTo: keyed('sales').id })).status, 400, 'only cash or bank');

  // An older receipt with no account: the sync fixes it once and keeps it.
  await db.collection('receipts').updateOne({ _id: h.asId(plain.id) }, { $set: { depositTo: null } });
  await owner.post('/api/books/sync');
  assert.equal(String((await db.collection('receipts').findOne({ _id: h.asId(plain.id) })).depositTo), oldBank);

  assert.equal((await owner.put('/api/books/settings', { defaultBank: secondId })).status, 200);
  await sync();
  const v1 = await voucherOf(`receipt:${plain.id}`);
  assert.equal(String(v1.lines.find((l) => l.debit > 0).account), oldBank, 'still in the old bank');
  const v2 = await voucherOf(`receipt:${chosen.id}`);
  assert.equal(String(v2.lines.find((l) => l.debit > 0).account), secondId);
  await owner.put('/api/books/settings', { defaultBank: oldBank });
});

test('order payments: deposit account stored; nothing dated before the books start', async () => {
  const { order } = await approvedOrder();
  const early = await owner.post(`/api/sales-orders/${order.id}/payments`, { amount: 10, method: 'cash', receivedAt: '2026-03-15' });
  assert.equal(early.status, 400);
  assert.match(early.data.message, /books start/);
  const paid = await owner.post(`/api/sales-orders/${order.id}/payments`, { amount: 10, method: 'cash' });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  assert.equal(paid.data.data.payments[0].depositTo, keyed('cash').id);
  await sync();
  const v = await voucherOf(`orderpay:${order.id}:${paid.data.data.payments[0].id}`);
  assert.equal(String(v.lines.find((l) => l.debit > 0).account), keyed('cash').id);
});

test('receipts, invoices and credit notes cannot be dated before the books start', async () => {
  const { customer, order } = await approvedOrder();
  assert.equal((await owner.post(`/api/billing/customers/${customer.id}/receipts`, { amount: 10, receivedAt: '2026-03-20' })).status, 400);
  assert.equal((await owner.post(`/api/billing/orders/${order.id}/invoices`, { invoiceDate: '2026-03-20', billAhead: true, billAheadReason: 'old', lines: [{ itemId: order.items[0].id, quantity: 1 }] })).status, 400);
  assert.equal((await owner.post(`/api/billing/customers/${customer.id}/credit-notes`, { date: '2026-03-20', reason: 'rate difference', lines: [{ amount: 10, gstPercent: 18 }] })).status, 400);
});

test('the books never change a voucher dated in a locked period', async () => {
  const { customer } = await approvedOrder();
  const r = (await owner.post(`/api/billing/customers/${customer.id}/receipts`, { amount: 300, method: 'upi' })).data.data;
  await sync();
  assert.equal((await owner.put('/api/books/settings', { lockDate: today })).status, 200);
  await db.collection('receipts').updateOne({ _id: h.asId(r.id) }, { $set: { amount: 999, updatedAt: new Date() } });
  await owner.post('/api/books/sync');
  assert.equal((await voucherOf(`receipt:${r.id}`)).total, 300, 'locked voucher kept');
  await owner.put('/api/books/settings', { lockDate: '' });
  await db.collection('receipts').updateOne({ _id: h.asId(r.id) }, { $set: { amount: 300 } });
});

test('approve: a credit hold found at approval is saved on the order before refusing', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Tight Credit Co', creditLimit: 1 })).data.data;
  const created = await owner.post('/api/sales-orders', { customerId: customer.id, deliveryDate: '2099-01-01', items: await completeLines() });
  const id = created.data.data.id;
  assert.equal((await owner.post(`/api/sales-orders/${id}/submit`)).status, 200);
  await db.collection('salesorders').updateOne({ _id: h.asId(id) }, { $set: { creditCheck: null } });
  const res = await owner.post(`/api/sales-orders/${id}/approve`, {});
  assert.equal(res.status, 409);
  assert.match(res.data.message, /credit/i);
  const saved = await db.collection('salesorders').findOne({ _id: h.asId(id) });
  assert.equal(saved.creditCheck?.status, 'hold');
  assert.equal(saved.status, 'submitted');
});

test('money left on a delivered order pays the customer\'s other bills', async () => {
  const { customer, order } = await approvedOrder({}, {});
  await db.collection('salesorders').updateOne({ _id: h.asId(order.id) }, { $set: { advanceAmount: 400, orderDate: new Date() } });
  await owner.post(`/api/billing/customers/${customer.id}/openings`, { number: 'OLD-9', date: '2026-03-01', amount: 250 });
  const open = (await owner.get(`/api/billing/customers/${customer.id}/ledger`)).data.data;
  assert.equal(open.invoices.find((i) => i.number === 'OLD-9').paid, 0, 'an open order keeps its advance');
  await db.collection('salesorders').updateOne({ _id: h.asId(order.id) }, { $set: { status: 'delivered' } });
  const done = (await owner.get(`/api/billing/customers/${customer.id}/ledger`)).data.data;
  assert.equal(done.invoices.find((i) => i.number === 'OLD-9').paid, 250);
  assert.equal(done.summary.advance, 150);
  await db.collection('salesorders').updateOne({ _id: h.asId(order.id) }, { $set: { advanceAmount: 0 } });
});

test('receivables list customers who only have money on an order', async () => {
  const { customer, order } = await approvedOrder();
  assert.equal((await owner.post(`/api/sales-orders/${order.id}/payments`, { amount: 20, method: 'upi' })).status, 201);
  const rows = (await owner.get('/api/billing/receivables')).data.data.rows;
  const row = rows.find((r) => r.id === customer.id);
  assert.ok(row, 'listed');
  assert.equal(row.advance, 20);
});

test('customers: switching active needs no mandatory fields; an old invalid product does not block a save', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Legacy Customer' })).data.data;
  assert.equal((await owner.put('/api/form-fields', { required: { customer: { mobile: true } } })).status, 200);
  assert.equal((await owner.patch(`/api/customers/${customer.id}`, { companyName: 'X' })).status, 400, 'editing still checks');
  assert.equal((await owner.patch(`/api/customers/${customer.id}`, { isActive: false })).status, 200);
  assert.equal((await owner.patch(`/api/customers/${customer.id}`, { isActive: true })).status, 200);
  await owner.put('/api/form-fields', { required: { customer: { mobile: false } } });

  const [good] = await completeLines();
  const saved = await owner.patch(`/api/customers/${customer.id}`, { products: [good] });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const productId = saved.data.data.products[0].id;
  await db.collection('customers').updateOne({ _id: h.asId(customer.id) }, { $set: { 'products.0.discount': 1e12 } });
  const loaded = (await owner.get(`/api/customers/${customer.id}`)).data.data;
  assert.ok(loaded.products[0].needsReview, 'old product flagged');
  const again = await owner.patch(`/api/customers/${customer.id}`, { products: [...loaded.products, { ...good, product: 'Another bag' }] });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.data.products.length, 2);
  assert.equal(again.data.data.products.find((p) => p.id === productId).discount, 1e12, 'kept as stored');
});

test('purchases: no GST without a GSTIN; bills with payments or notes stay; notes add up against the bill', async () => {
  const plain = (await owner.post('/api/suppliers', { name: 'Unregistered Supplies' })).data.data;
  const taxed = await owner.post('/api/purchases/bills', { supplierId: plain.id, supplierBillNo: 'U1', billDate: today, lines: [{ description: 'Cartons', quantity: 10, rate: 100, gstPercent: 18 }] });
  assert.equal(taxed.status, 400);
  assert.match(taxed.data.message, /no GSTIN/);
  assert.equal((await owner.post('/api/purchases/bills', { supplierId: plain.id, supplierBillNo: 'U1', billDate: today, lines: [{ description: 'Cartons', quantity: 10, rate: 100, gstPercent: 0 }] })).status, 201);

  const supplier = (await owner.post('/api/suppliers', { name: 'Registered Supplies', gstNumber: '07AABCR1234E1Z5' })).data.data;
  const bill = (await owner.post('/api/purchases/bills', { supplierId: supplier.id, supplierBillNo: 'R1', billDate: today, lines: [{ description: 'Ink', quantity: 10, rate: 100, gstPercent: 18 }] })).data.data;
  assert.equal(bill.total, 1180);
  const note = (amount) => owner.post(`/api/purchases/suppliers/${supplier.id}/debit-notes`, { billId: bill.id, date: today, reason: 'returned', lines: [{ description: 'Ink back', amount, gstPercent: 18 }] });
  assert.equal((await note(600)).status, 201);
  const second = await note(500);
  assert.equal(second.status, 400, 'together more than the bill');
  assert.match(second.data.message, /already noted/);
  const cancel = await owner.post(`/api/purchases/bills/${bill.id}/cancel`, { reason: 'entered twice' });
  assert.equal(cancel.status, 400);
  assert.match(cancel.data.message, /Debit notes/);

  const bill2 = (await owner.post('/api/purchases/bills', { supplierId: supplier.id, supplierBillNo: 'R2', billDate: today, lines: [{ description: 'Ink', quantity: 1, rate: 100, gstPercent: 18 }] })).data.data;
  assert.equal((await owner.post(`/api/purchases/suppliers/${supplier.id}/payments`, { billId: bill2.id, amount: 50, method: 'upi' })).status, 201);
  const cancel2 = await owner.post(`/api/purchases/bills/${bill2.id}/cancel`, { reason: 'entered twice' });
  assert.equal(cancel2.status, 400);
  assert.match(cancel2.data.message, /Payments/);
  assert.equal((await owner.get('/api/purchases/payables')).status, 200);
});

test('GSTR-3B: input credit reversed by debit notes beyond a month\'s bills comes off the next month', async () => {
  const supplier = (await owner.post('/api/suppliers', { name: 'ITC Supplier', gstNumber: '07AABCI1234E1Z5' })).data.data;
  const bill = await owner.post('/api/purchases/bills', { supplierId: supplier.id, supplierBillNo: 'ITC1', billDate: '2026-08-10', lines: [{ description: 'Film', quantity: 100, rate: 100, gstPercent: 18 }] });
  assert.equal(bill.status, 201, JSON.stringify(bill.data));
  const dn = await owner.post(`/api/purchases/suppliers/${supplier.id}/debit-notes`, { billId: bill.data.data.id, date: '2026-09-10', reason: 'returned', lines: [{ description: 'Film back', amount: 5000, gstPercent: 18 }] });
  assert.equal(dn.status, 201, JSON.stringify(dn.data));
  const aug = (await owner.get('/api/books/statements/gstr3b?month=2026-08')).data.data;
  const sep = (await owner.get('/api/books/statements/gstr3b?month=2026-09')).data.data;
  const total = (o) => r2(o.igst + o.cgst + o.sgst);
  const augCarried = total(aug.carried);
  assert.ok(augCarried >= 1800, 'August input credit carried');
  assert.equal(total(sep.creditAvailable), r2(augCarried - 900), 'the reversal comes off what was carried');
});

test('invoice prefix keeps the invoice number within 16 characters', async () => {
  const long = await owner.put('/api/company-settings', { invoicePrefix: 'SINOPEC' });
  assert.equal(long.status, 400);
  assert.match(long.data.message, /16/);
  assert.equal((await owner.put('/api/company-settings', { invoicePrefix: 'SNPEC' })).status, 200);
  await owner.put('/api/company-settings', { invoicePrefix: 'SP' });
});

test('accounts report: a cancelled order\'s advance is collected; TDS shown apart', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Report Advance Co' })).data.data;
  const created = await owner.post('/api/sales-orders', { customerId: customer.id, deliveryDate: '2099-01-01', advanceAmount: 777, items: await completeLines() });
  assert.equal(created.status, 201);
  assert.equal((await owner.post(`/api/sales-orders/${created.data.data.id}/cancel`, { reason: 'cancelled' })).status, 200);
  await owner.post(`/api/billing/customers/${customer.id}/receipts`, { amount: 900, tds: 100, method: 'upi' });
  const report = (await owner.get(`/api/reports/accounts?from=${today}&to=${today}`)).data.data;
  assert.ok(report.receiptRegister.some((r) => r.number === created.data.data.number && r.amount === 777));
  assert.ok(report.kpis.tdsDeducted >= 100);
});
