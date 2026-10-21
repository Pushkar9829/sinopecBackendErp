const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
let accounts;
let order;
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const acct = (key) => accounts.find((a) => a.key === key);
const tb = async (c = owner) => (await c.get('/api/books/trial-balance')).data.data;
const balanceOf = (trial, id) => {
  for (const g of trial.groups) {
    const row = g.accounts.find((a) => a.id === id);
    if (row) return row.debit - row.credit;
  }
  return 0;
};

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  accounts = (await owner.get('/api/books/accounts')).data.data;
  order = await db.collection('salesorders').findOne({ status: { $in: ['dispatched', 'delivered', 'completed'] }, 'items.stageWork.stage': 'dispatch' });
  await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5' });
});
after(h.stopApp);

test('the chart starts with the system accounts and starter heads', async () => {
  for (const key of ['cash', 'bank', 'sales', 'output_cgst', 'output_sgst', 'output_igst', 'round_off', 'capital']) assert.ok(acct(key), key);
  assert.ok(accounts.some((a) => a.name === 'Wages' && a.group === 'direct_expenses'));
  const trial = await tb();
  assert.equal(trial.difference, trial.openingDifference, 'vouchers always balance; only openings can differ');
});

test('a sale invoice posts Dr customer, Cr sales and GST; cancelling it takes it out', async () => {
  const before = await tb();
  const draft = (await owner.get(`/api/billing/orders/${order._id}/invoice-draft`)).data.data;
  const line = draft.lines.find((l) => l.suggested > 0);
  const inv = (await owner.post(`/api/billing/orders/${order._id}/invoices`, { invoiceDate: today, lines: [{ itemId: line.itemId, quantity: line.suggested }] })).data.data;
  const after = await tb();
  assert.ok(Math.abs(balanceOf(after, acct('sales').id) - balanceOf(before, acct('sales').id) + inv.taxable) < 0.01, 'sales credited with the taxable value');
  const gst = ['output_cgst', 'output_sgst', 'output_igst'].reduce((s, k) => s + balanceOf(after, acct(k).id) - balanceOf(before, acct(k).id), 0);
  assert.ok(Math.abs(gst + inv.cgst + inv.sgst + inv.igst) < 0.01, 'GST credited');
  assert.equal(after.difference, after.openingDifference);
  const day = (await owner.get(`/api/books/vouchers?type=sales&from=${today}&to=${today}`)).data.data;
  const v = day.items.find((x) => x.number === inv.number);
  assert.ok(v && v.auto && v.lines.reduce((s, l) => s + l.debit, 0) === inv.total);

  await owner.post(`/api/billing/invoices/${inv.id}/cancel`, { reason: 'Wrong quantity' });
  const gone = await tb();
  assert.ok(Math.abs(balanceOf(gone, acct('sales').id) - balanceOf(before, acct('sales').id)) < 0.01, 'cancelled invoice leaves the books');
  const cancelled = (await owner.get(`/api/books/vouchers?status=cancelled&from=${today}&to=${today}`)).data.data;
  assert.ok(cancelled.items.some((x) => x.number === inv.number));
});

test('payments go to bank (or cash), voids reverse, and the customer ledger matches the trial balance', async () => {
  const customerId = String(order.customer);
  const before = await tb();
  await owner.post(`/api/billing/customers/${customerId}/receipts`, { amount: 1500, receivedAt: today, method: 'upi' });
  const cash = (await owner.post(`/api/billing/customers/${customerId}/receipts`, { amount: 400, receivedAt: today, method: 'cash' })).data.data;
  const after = await tb();
  assert.ok(Math.abs(balanceOf(after, acct('bank').id) - balanceOf(before, acct('bank').id) - 1500) < 0.01);
  assert.ok(Math.abs(balanceOf(after, acct('cash').id) - balanceOf(before, acct('cash').id) - 400) < 0.01);
  await owner.post(`/api/billing/receipts/${cash.id}/void`, { reason: 'Entered twice' });
  const voided = await tb();
  assert.ok(Math.abs(balanceOf(voided, acct('cash').id) - balanceOf(before, acct('cash').id)) < 0.01);

  const party = (await owner.get('/api/books/accounts')).data.data.find((a) => a.customer === customerId);
  const ledger = (await owner.get(`/api/books/ledger/${party.id}?from=2026-01-01`)).data.data;
  assert.ok(Math.abs(ledger.closing - balanceOf(voided, party.id)) < 0.01, 'ledger closing = trial balance');
  const last = ledger.entries.at(-1);
  assert.equal(last.balance, ledger.closing);
});

test('manual entries: must balance, use the right accounts, and respect the start and lock dates', async () => {
  const wages = accounts.find((a) => a.name === 'Wages');
  const post = (body) => owner.post('/api/books/vouchers', { date: today, narration: 'test', ...body });
  assert.equal((await post({ type: 'journal', lines: [{ account: wages.id, debit: 100 }, { account: acct('cash').id, credit: 90 }] })).status, 400, 'unbalanced');
  const party = (await owner.get('/api/books/accounts')).data.data.find((a) => a.customer);
  assert.equal((await post({ type: 'journal', lines: [{ account: party.id, debit: 50 }, { account: acct('cash').id, credit: 50 }] })).status, 400, 'customer accounts only through billing');
  assert.equal((await post({ type: 'contra', lines: [{ account: wages.id, debit: 50 }, { account: acct('cash').id, credit: 50 }] })).status, 400, 'contra is cash/bank only');
  assert.equal((await post({ type: 'payment', lines: [{ account: wages.id, debit: 50 }, { account: acct('capital').id, credit: 50 }] })).status, 400, 'payment comes out of cash/bank');

  const paid = await post({ type: 'payment', narration: 'Wages for the week', lines: [{ account: wages.id, debit: 2500 }, { account: acct('cash').id, credit: 2500 }] });
  assert.equal(paid.status, 201, JSON.stringify(paid.data));
  assert.match(paid.data.data.number, /^PV\/\d{2}-\d{2}\/\d{4}$/);
  const contra = await post({ type: 'contra', lines: [{ account: acct('bank').id, debit: 1000 }, { account: acct('cash').id, credit: 1000 }] });
  assert.equal(contra.status, 201);

  assert.equal((await post({ type: 'journal', date: '2020-01-01', lines: [{ account: wages.id, debit: 1 }, { account: acct('cash').id, credit: 1 }] })).status, 400, 'before the books start');
  assert.equal((await owner.put('/api/books/settings', { lockDate: today })).status, 200);
  assert.equal((await post({ type: 'journal', lines: [{ account: wages.id, debit: 1 }, { account: acct('cash').id, credit: 1 }] })).status, 400, 'locked');
  assert.equal((await owner.post(`/api/books/vouchers/${paid.data.data.id}/cancel`, { reason: 'mistake' })).status, 400, 'locked too');
  await owner.put('/api/books/settings', { lockDate: '' });
  assert.equal((await owner.post(`/api/books/vouchers/${paid.data.data.id}/cancel`, {})).status, 400, 'needs a reason');
  assert.equal((await owner.post(`/api/books/vouchers/${paid.data.data.id}/cancel`, { reason: 'Paid by bank instead' })).status, 200);
});

test('opening balances: entered per account, and the difference is shown until they balance', async () => {
  const trial0 = await tb();
  const res = await owner.put('/api/books/openings', { rows: [{ accountId: acct('capital').id, credit: 500000 }, { accountId: acct('bank').id, debit: 500000 }] });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.data.openingDifference, trial0.openingDifference, 'a balanced pair changes nothing');
  const lopsided = await owner.put('/api/books/openings', { rows: [{ accountId: acct('capital').id, credit: 400000 }] });
  assert.ok(Math.abs(lopsided.data.data.openingDifference - trial0.openingDifference - 100000) < 0.01);
  assert.equal((await owner.put('/api/books/openings', { rows: [{ accountId: acct('capital').id, debit: 1, credit: 1 }] })).status, 400);
});

test('who can use the books', async () => {
  const accountsUser = await h.signIn('accounts');
  assert.equal((await accountsUser.get('/api/books/trial-balance')).status, 200);
  const sales = await h.signIn('sales');
  assert.equal((await sales.get('/api/books/trial-balance')).status, 403);
  const production = await h.signIn('production');
  assert.equal((await production.get('/api/books/accounts')).status, 403);
  assert.equal((await production.post('/api/books/vouchers', { type: 'journal' })).status, 403);
});

test('for every customer, the books agree with billing (owed minus advance)', async () => {
  const receivables = (await owner.get('/api/billing/receivables')).data.data.rows;
  const trial = await tb();
  const parties = (await owner.get('/api/books/accounts')).data.data.filter((a) => a.customer);
  assert.ok(receivables.length > 0);
  for (const r of receivables) {
    const party = parties.find((p) => p.customer === r.id);
    const books = party ? balanceOf(trial, party.id) : 0;
    assert.ok(Math.abs(books - (r.outstanding - r.advance)) < 0.01, `${r.name}: books ${books} vs billing ${r.outstanding - r.advance}`);
  }
});
