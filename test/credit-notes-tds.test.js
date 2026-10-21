const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
let accounts;
let order;
let customerId;
let invoice;
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const acct = (key) => accounts.find((a) => a.key === key);
const tb = async () => (await owner.get('/api/books/trial-balance')).data.data;
const bal = (trial, id) => {
  for (const g of trial.groups) {
    const row = g.accounts.find((a) => a.id === id);
    if (row) return Math.round((row.debit - row.credit) * 100) / 100;
  }
  return 0;
};
const ledger = async () => (await owner.get(`/api/billing/customers/${customerId}/ledger`)).data.data;
const partyBalance = async () => {
  const party = (await owner.get('/api/books/accounts')).data.data.find((a) => a.customer === customerId);
  return bal(await tb(), party.id);
};

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5' });
  accounts = (await owner.get('/api/books/accounts')).data.data;
  order = await db.collection('salesorders').findOne({ status: { $in: ['dispatched', 'delivered', 'completed'] }, 'items.stageWork.stage': 'dispatch' });
  customerId = String(order.customer);
  const draft = (await owner.get(`/api/billing/orders/${order._id}/invoice-draft`)).data.data;
  const line = draft.lines.find((l) => l.suggested > 0);
  invoice = (await owner.post(`/api/billing/orders/${order._id}/invoices`, { invoiceDate: today, lines: [{ itemId: line.itemId, quantity: line.suggested }] })).data.data;
  // Money already on the order would settle the bill before the notes; keep it clean.
  await db.collection('salesorders').updateOne({ _id: order._id }, { $set: { advanceAmount: 0, payments: [], updatedAt: new Date() } });
});
after(h.stopApp);

test('the new system accounts exist', () => {
  for (const key of ['sales_returns', 'bad_debts', 'tds_receivable', 'tds_payable']) assert.ok(acct(key), key);
});

test('a credit note reverses sales and GST, lowers the bill, and prints from its own record', async () => {
  const before = await tb();
  const outBefore = (await ledger()).invoices.find((i) => i.id === invoice.id).balance;
  const res = await owner.post(`/api/billing/customers/${customerId}/credit-notes`, {
    date: today,
    invoiceId: invoice.id,
    reason: 'Rate difference agreed',
    lines: [{ description: 'Rate difference', hsnCode: '3923', amount: 1000, gstPercent: 18 }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const note = res.data.data;
  assert.match(note.number, /^CN\/\d{2}-\d{2}\/\d{4}$/);
  assert.equal(note.taxable, 1000);
  assert.equal(note.total, 1180);
  assert.equal(note.cgst + note.sgst + note.igst, 180);
  const after = await tb();
  assert.equal(bal(after, acct('sales_returns').id) - bal(before, acct('sales_returns').id), 1000);
  const gst = ['output_cgst', 'output_sgst', 'output_igst'].reduce((s, k) => s + bal(after, acct(k).id) - bal(before, acct(k).id), 0);
  assert.equal(Math.round(gst * 100) / 100, 180, 'output GST comes down');
  assert.equal(after.difference, after.openingDifference);
  const l = await ledger();
  assert.equal(l.invoices.find((i) => i.id === invoice.id).balance, Math.round((outBefore - 1180) * 100) / 100);
  assert.ok(l.entries.some((e) => e.type === 'credit_note' && e.ref === note.number && e.credit === 1180));
  const printed = (await owner.get(`/api/billing/credit-notes/${note.id}`)).data.data;
  assert.equal(printed.invoiceNumber, invoice.number);
  assert.ok(printed.seller && printed.buyer);

  const tooBig = await owner.post(`/api/billing/customers/${customerId}/credit-notes`, { date: today, invoiceId: invoice.id, reason: 'Too much', lines: [{ amount: invoice.total * 2, gstPercent: 0 }] });
  assert.equal(tooBig.status, 400);

  const list = (await owner.get(`/api/billing/credit-notes?customer=${customerId}`)).data.data;
  assert.equal(list.total, 1);
  assert.equal(list.sums.total, 1180);

  await owner.post(`/api/billing/credit-notes/${note.id}/cancel`, { reason: 'Entered by mistake' });
  const undone = await tb();
  assert.equal(bal(undone, acct('sales_returns').id), bal(before, acct('sales_returns').id));
  assert.equal((await ledger()).invoices.find((i) => i.id === invoice.id).balance, outBefore);
});

test('a receipt with TDS settles the full bill; TDS goes to TDS receivable', async () => {
  const l = await ledger();
  const bill = l.invoices.find((i) => i.id === invoice.id);
  const tds = Math.round(bill.balance * 0.02);
  const before = await tb();
  const res = await owner.post(`/api/billing/customers/${customerId}/receipts`, { amount: bill.balance - tds, tds, tdsSection: '194q', receivedAt: today, method: 'upi', invoiceId: invoice.id });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.data.tdsSection, '194Q');
  const after = await tb();
  assert.equal(bal(after, acct('tds_receivable').id) - bal(before, acct('tds_receivable').id), tds);
  assert.equal(Math.round((bal(after, acct('bank').id) - bal(before, acct('bank').id)) * 100) / 100, Math.round((bill.balance - tds) * 100) / 100);
  assert.equal((await ledger()).invoices.find((i) => i.id === invoice.id).balance, 0, 'paid in full');
  assert.equal(await partyBalance(), (await ledger()).summary.net, 'books agree with billing');

  const silly = await owner.post(`/api/billing/customers/${customerId}/receipts`, { amount: 100, tds: 500, receivedAt: today });
  assert.equal(silly.status, 400);

  const summary = (await owner.get(`/api/books/tds?from=${today}&to=${today}`)).data.data;
  assert.equal(summary.deductedFromUs.total, tds);
  assert.equal(summary.deductedFromUs.byCustomer[0].section, '194Q');
});

test('write-off clears an unpaid opening bill to bad debts, never more than is owed', async () => {
  await owner.post(`/api/billing/customers/${customerId}/openings`, { number: 'OLD-9', date: '2026-04-01', amount: 5000 });
  const old = (await ledger()).invoices.find((i) => i.number === 'OLD-9');
  const tooMuch = await owner.post(`/api/billing/customers/${customerId}/write-offs`, { invoiceId: old.id, amount: 6000, reason: 'Party closed', date: today });
  assert.equal(tooMuch.status, 400);
  const before = await tb();
  const res = await owner.post(`/api/billing/customers/${customerId}/write-offs`, { invoiceId: old.id, amount: 5000, reason: 'Party closed down', date: today });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.match(res.data.data.number, /^WO\//);
  const after = await tb();
  assert.equal(bal(after, acct('bad_debts').id) - bal(before, acct('bad_debts').id), 5000);
  assert.equal((await ledger()).invoices.find((i) => i.id === old.id).balance, 0);
  assert.equal(await partyBalance(), (await ledger()).summary.net);
  const production = await h.signIn('production');
  assert.equal((await production.post(`/api/billing/customers/${customerId}/write-offs`, { amount: 1, reason: 'test test' })).status, 403);
});

test('a supplier payment with TDS settles the bill; TDS payable shows what is owed and what was deposited', async () => {
  const supplier = (await owner.post('/api/suppliers', { name: 'Ram Transport', gstNumber: '07AABCR1234E1Z5' })).data.data;
  const bill = (
    await owner.post('/api/purchases/bills', {
      supplierId: supplier.id,
      supplierBillNo: 'RT-1',
      billDate: today,
      lines: [{ description: 'Freight', account: accounts.find((a) => a.name === 'Freight & cartage').id, amount: 10000, gstPercent: 0 }],
    })
  ).data.data;
  const before = await tb();
  const res = await owner.post(`/api/purchases/suppliers/${supplier.id}/payments`, { amount: 9800, tds: 200, tdsSection: '194C', paidAt: today, billId: bill.id });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const after = await tb();
  assert.equal(bal(after, acct('tds_payable').id) - bal(before, acct('tds_payable').id), -200);
  const account = (await owner.get(`/api/purchases/suppliers/${supplier.id}/account`)).data.data;
  assert.equal(account.bills.find((b) => b.id === bill.id).balance, 0);

  // Depositing it with the government: a payment voucher from the bank.
  const dep = await owner.post('/api/books/vouchers', { type: 'payment', date: today, narration: 'TDS deposited, challan 12345', lines: [{ account: acct('tds_payable').id, debit: 200 }, { account: acct('bank').id, credit: 200 }] });
  assert.equal(dep.status, 201, JSON.stringify(dep.data));
  const summary = (await owner.get(`/api/books/tds?from=${today}&to=${today}`)).data.data;
  assert.equal(summary.deductedByUs.total, 200);
  assert.equal(summary.deductedByUs.bySupplier[0].section, '194C');
  assert.equal(summary.deductedByUs.deposited, 200);
  assert.equal(summary.deductedByUs.owedNow, 0);
});

test('credit notes reach GSTR-1: CDNR for registered buyers or off B2C Small, and off the HSN summary', async () => {
  const note = (
    await owner.post(`/api/billing/customers/${customerId}/credit-notes`, {
      date: today,
      reason: 'Goods returned',
      lines: [{ description: 'Returned bags', hsnCode: '9999', quantity: 10, unit: 'kg', amount: 500, gstPercent: 18 }],
    })
  ).data.data;
  const report = (await owner.get(`/api/reports/accounts?from=${today}&to=${today}`)).data.data;
  assert.ok(report.creditNoteRegister.some((n) => n.number === note.number));
  assert.ok(report.creditNoteRegister.some((n) => n.kind === 'write_off'));
  assert.equal(report.kpis.creditNotes, note.total);
  const inCdnr = report.gst.cdnr.filter((r) => r.number === note.number);
  if (note.buyer.gstin) assert.equal(inCdnr[0].taxable, 500);
  else assert.equal(inCdnr.length, 0);
  const hsn = report.gst.hsn.find((r) => r.hsn === '9999');
  assert.equal(hsn.taxable, -500);
  assert.equal(hsn.quantity, -10);
});
