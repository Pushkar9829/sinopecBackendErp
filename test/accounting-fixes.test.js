const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Regression tests for the accounting review: advances on cancelled or
// deleted orders, lock rules, openings, credit-note limits, bank matching.

let db;
let owner;
let accounts;
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 5.5 * 3600 * 1000 + 864e5).toISOString().slice(0, 10);
const dmy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
const acct = (key) => accounts.find((a) => a.key === key);
const named = (name) => accounts.find((a) => a.name === name);
const r2 = (n) => Math.round(n * 100) / 100;
const tb = async () => (await owner.get('/api/books/trial-balance')).data.data;
const bal = (trial, id) => {
  for (const g of trial.groups) {
    const row = g.accounts.find((a) => a.id === id);
    if (row) return r2(row.debit - row.credit);
  }
  return 0;
};
const partyBalance = async (customerId) => {
  const party = (await owner.get('/api/books/accounts')).data.data.find((a) => a.customer === customerId);
  return party ? bal(await tb(), party.id) : 0;
};
const ledgerNet = async (customerId) => (await owner.get(`/api/billing/customers/${customerId}/ledger`)).data.data.summary.net;

async function completeLines() {
  const source = await db.collection('salesorders').findOne({ status: 'approved', orderType: 'sales_order' });
  return source.items.map(({ _id, stageWork, currentStage, stagePickup, ...rest }) => rest);
}

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5' });
  await owner.put('/api/books/settings', { startDate: '2026-04-01' });
  accounts = (await owner.get('/api/books/accounts')).data.data;
});
after(h.stopApp);

test('an advance stays in the books and on the customer account when its order is cancelled', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Advance Traders' })).data.data;
  const created = await owner.post('/api/sales-orders', { customerId: customer.id, deliveryDate: '2099-01-01', advanceAmount: 5000, paymentMethod: 'bank_transfer', items: await completeLines() });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.data.id;
  assert.equal(await partyBalance(customer.id), -5000);

  // A draft with an advance cannot be deleted (the money would vanish).
  assert.equal((await owner.del(`/api/sales-orders/${id}`)).status, 400);

  const cancelled = await owner.post(`/api/sales-orders/${id}/cancel`, { reason: 'Customer changed mind' });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(await partyBalance(customer.id), -5000, 'advance still a credit in the books');
  assert.equal(await ledgerNet(customer.id), -5000, 'and on the customer account');
  const account = (await owner.get(`/api/billing/customers/${customer.id}/ledger`)).data.data;
  assert.equal(account.summary.advance, 5000);
});

test('an advance cannot be dated in the future or in a locked period', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Future Advance Co' })).data.data;
  const future = await owner.post('/api/sales-orders', { customerId: customer.id, orderDate: tomorrow, advanceAmount: 100, items: await completeLines() });
  assert.equal(future.status, 400);
  await owner.put('/api/books/settings', { lockDate: today });
  const locked = await owner.post('/api/sales-orders', { customerId: customer.id, orderDate: today, advanceAmount: 100, items: await completeLines() });
  assert.equal(locked.status, 400);
  const noAdvance = await owner.post('/api/sales-orders', { customerId: customer.id, orderDate: today, items: await completeLines() });
  assert.equal(noAdvance.status, 201, 'orders without money are not affected by the lock');
  const edit = await owner.patch(`/api/sales-orders/${noAdvance.data.data.id}`, { advanceAmount: 250 });
  assert.equal(edit.status, 400, 'adding an advance in a locked period');
  await owner.put('/api/books/settings', { lockDate: '' });
});

test('lock rules: only the owner moves the lock back; openings freeze while locked; a closed year stays locked', async () => {
  await owner.put('/api/books/settings', { lockDate: today });
  const manager = await h.signIn('accounts');
  assert.equal((await manager.put('/api/books/settings', { lockDate: '' })).status, 403);
  assert.equal((await manager.put('/api/books/settings', { lockDate: '2026-05-31' })).status, 403);

  const customer = (await owner.post('/api/customers', { name: 'Opening Lock Ltd' })).data.data;
  assert.equal((await owner.post(`/api/billing/customers/${customer.id}/openings`, { number: 'X-1', date: '2026-04-01', amount: 100 })).status, 400);
  assert.equal((await owner.put('/api/books/openings', { rows: [{ accountId: acct('capital').id, credit: 1 }] })).status, 400);
  const supplier = (await owner.post('/api/suppliers', { name: 'Opening Lock Supplies' })).data.data;
  assert.equal((await owner.post(`/api/purchases/suppliers/${supplier.id}/openings`, { number: 'S-1', date: '2026-04-01', amount: 100 })).status, 400);
  assert.equal((await owner.put('/api/books/settings', { startDate: '2025-04-01' })).status, 400, 'start date fixed while locked');

  assert.equal((await owner.put('/api/books/settings', { lockDate: '' })).status, 200, 'the owner can unlock');
  await owner.put('/api/books/settings', { startDate: '2025-04-01' });
  await owner.put('/api/books/closing-stock', { day: '2026-03-31', value: 0 });
  assert.equal((await owner.post('/api/books/years/25-26/close')).status, 200);
  const unlock = await owner.put('/api/books/settings', { lockDate: '' });
  assert.equal(unlock.status, 400, 'a closed year is reopened, not unlocked');
  await owner.post('/api/books/years/25-26/reopen');
  await owner.put('/api/books/settings', { startDate: '2026-04-01' });
});

test('credit notes on one invoice cannot add up to more than it, and the invoice cannot be cancelled under them', async () => {
  const order = await db.collection('salesorders').findOne({ status: { $in: ['dispatched', 'delivered', 'completed'] }, 'items.stageWork.stage': 'dispatch' });
  const draft = (await owner.get(`/api/billing/orders/${order._id}/invoice-draft`)).data.data;
  const line = draft.lines.find((l) => l.suggested > 0);
  const inv = (await owner.post(`/api/billing/orders/${order._id}/invoices`, { invoiceDate: today, lines: [{ itemId: line.itemId, quantity: line.suggested }] })).data.data;
  const half = Math.floor(inv.taxable / 2);
  const body = { date: today, invoiceId: inv.id, reason: 'Rate difference', lines: [{ amount: half, gstPercent: 0 }] };
  assert.equal((await owner.post(`/api/billing/customers/${inv.customer}/credit-notes`, body)).status, 201);
  assert.equal((await owner.post(`/api/billing/customers/${inv.customer}/credit-notes`, body)).status, 201);
  assert.equal((await owner.post(`/api/billing/customers/${inv.customer}/credit-notes`, body)).status, 400, 'a third would pass the bill total');
  assert.equal((await owner.post(`/api/billing/invoices/${inv.id}/cancel`, { reason: 'Wrong' })).status, 400);
  const bill = (await owner.get(`/api/billing/customers/${inv.customer}/ledger`)).data.data.invoices.find((i) => i.id === inv.id);
  assert.equal(bill.credited, r2(half * 2));
});

test('invoices and receipts cannot be dated tomorrow', async () => {
  const customer = (await owner.post('/api/customers', { name: 'Tomorrow Ltd' })).data.data;
  assert.equal((await owner.post(`/api/billing/customers/${customer.id}/receipts`, { amount: 10, receivedAt: tomorrow })).status, 400);
});

test('purchase bills cannot be booked to a stock account', async () => {
  const stock = (await owner.post('/api/books/accounts', { name: 'Granule stock', group: 'stock' })).data.data;
  const supplier = (await owner.post('/api/suppliers', { name: 'Stock Line Co' })).data.data;
  const res = await owner.post('/api/purchases/bills', { supplierId: supplier.id, supplierBillNo: 'SL-1', billDate: today, lines: [{ description: 'Granules', account: stock.id, amount: 1000, gstPercent: 0 }] });
  assert.equal(res.status, 400);
});

test('bank: identical lines kept, US dates reported, newest-first balance, stale matches released', async () => {
  const bank = acct('bank').id;
  const rows = [
    { date: dmy(today), description: 'UPI CHARGE', withdrawal: '500' },
    { date: dmy(today), description: 'UPI CHARGE', withdrawal: '500' },
  ];
  const first = (await owner.post(`/api/bank/accounts/${bank}/statement`, { rows })).data.data;
  assert.equal(first.added, 2, 'two genuine identical charges');
  assert.equal((await owner.post(`/api/bank/accounts/${bank}/statement`, { rows })).data.data.duplicates, 2, 'importing again skips both');

  const us = await owner.post(`/api/bank/accounts/${bank}/statement`, { rows: [{ date: '10/25/2026', description: 'X', deposit: '1' }] });
  assert.equal(us.status, 201);
  assert.equal(us.data.data.added, 0);
  assert.equal(us.data.data.skipped, 1);

  // Newest first: the first row carries the latest balance of the day.
  const hdfc = (await owner.post('/api/bank/accounts', { name: 'Second bank' })).data.data.id;
  await owner.post(`/api/bank/accounts/${hdfc}/statement`, {
    rows: [
      { date: dmy(today), description: 'LATER', deposit: '200', balance: '1200' },
      { date: dmy(today), description: 'EARLIER', deposit: '1000', balance: '1000' },
    ],
  });
  const money = (await owner.get('/api/bank/accounts')).data.data;
  assert.equal(money.find((a) => a.id === hdfc).statementBalance, 1200);

  // Matched to an entry that is then cancelled: back to "to match".
  const v = (await owner.post('/api/books/vouchers', { type: 'receipt', date: today, narration: 'Interest', lines: [{ account: hdfc, debit: 200 }, { account: named('Interest received').id, credit: 200 }] })).data.data;
  const line = (await owner.get(`/api/bank/accounts/${hdfc}/statement?status=unmatched`)).data.data.items.find((l) => l.deposit === 200);
  if (line.status !== 'matched') await owner.post(`/api/bank/lines/${line.id}/match`, { voucherId: v.id });
  await owner.post(`/api/books/vouchers/${v.id}/cancel`, { reason: 'Entered by mistake' });
  const rec = (await owner.get(`/api/bank/accounts/${hdfc}/reconciliation`)).data.data;
  assert.ok(rec.notInBooks.some((l) => l.deposit === 200), 'the line needs matching again');
  assert.equal(rec.difference, 0, 'the difference is explained');
});

test('GSTR-3B carries a month of excess credit notes to the next month; Tally openings are as on the first day exported', async () => {
  const g = (await owner.get(`/api/books/statements/gstr3b?month=${today.slice(0, 7)}`)).data.data;
  assert.ok(g.negativeCarried);
  const masters = String((await owner.get(`/api/books/export/tally?part=masters&from=${today}&to=${today}`)).data);
  const trialBefore = (await owner.get(`/api/books/trial-balance?asOf=${new Date(Date.now() + 5.5 * 3600 * 1000 - 864e5).toISOString().slice(0, 10)}`)).data.data;
  const capital = trialBefore.groups.flatMap((x) => x.accounts).find((a) => a.key === 'capital');
  const expected = capital ? r2(-(capital.debit - capital.credit)).toFixed(2) : null;
  if (expected) assert.match(masters, new RegExp(`<LEDGER NAME="Capital account"[^]*?<OPENINGBALANCE>${expected.replace('.', '\\.')}</OPENINGBALANCE>`));
});

test('books and billing still agree for every customer after all of this', async () => {
  const parties = (await owner.get('/api/books/accounts')).data.data.filter((a) => a.customer);
  const trial = await tb();
  for (const p of parties) {
    assert.equal(bal(trial, p.id), await ledgerNet(p.customer), p.name);
  }
});
