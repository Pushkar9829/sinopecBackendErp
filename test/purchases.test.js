const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
let local;
let outside;
let accounts;
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const acct = (key) => accounts.find((a) => a.key === key);
const named = (name) => accounts.find((a) => a.name === name);
const tb = async () => (await owner.get('/api/books/trial-balance')).data.data;
const bal = (trial, id) => {
  for (const g of trial.groups) {
    const row = g.accounts.find((a) => a.id === id);
    if (row) return Math.round((row.debit - row.credit) * 100) / 100;
  }
  return 0;
};

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5' });
  await owner.put('/api/books/settings', { startDate: '2026-04-01' });
  local = (await owner.post('/api/suppliers', { name: 'Delhi Granules Co', gstNumber: '07AABCD1234E1Z5', creditDays: 15 })).data.data;
  outside = (await owner.post('/api/suppliers', { name: 'Mumbai Inks Ltd', gstNumber: '27AABCM1234E1Z5' })).data.data;
  accounts = (await owner.get('/api/books/accounts')).data.data;
});
after(h.stopApp);

const billBody = (extra = {}) => ({
  supplierId: local.id,
  supplierBillNo: 'DG/101',
  billDate: today,
  lines: [
    { description: 'LDPE granules', quantity: 500, unit: 'kg', rate: 110, gstPercent: 18 },
    { description: 'Freight', account: named('Freight & cartage').id, amount: 1500, gstPercent: 5 },
  ],
  ...extra,
});

test('a supplier bill: GST split by state, rounded total, due date from credit days, and the books', async () => {
  const before = await tb();
  const res = await owner.post('/api/purchases/bills', billBody());
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const bill = res.data.data;
  assert.equal(bill.intraState, true);
  assert.equal(bill.taxable, 55000 + 1500);
  assert.equal(bill.cgst, 4950 + 37.5);
  assert.equal(bill.sgst, 4950 + 37.5);
  assert.equal(bill.igst, 0);
  assert.equal(bill.total, Math.round(56500 + 9975));
  assert.match(bill.number, /^PB\/\d{2}-\d{2}\/\d{4}$/);
  const dueIn = Math.round((new Date(bill.dueDate) - new Date(bill.billDate)) / 864e5);
  assert.ok(dueIn >= 15 && dueIn <= 16, 'due 15 days later');

  const after = await tb();
  assert.equal(bal(after, acct('purchases').id) - bal(before, acct('purchases').id), 55000);
  assert.equal(bal(after, named('Freight & cartage').id) - bal(before, named('Freight & cartage').id), 1500);
  assert.equal(bal(after, acct('input_cgst').id) - bal(before, acct('input_cgst').id), 4987.5);
  assert.equal(after.difference, after.openingDifference, 'books still balance');

  const dup = await owner.post('/api/purchases/bills', billBody());
  assert.equal(dup.status, 409, 'same supplier bill twice');
  const early = await owner.post('/api/purchases/bills', billBody({ supplierBillNo: 'DG/OLD', billDate: '2026-01-10' }));
  assert.equal(early.status, 400, 'before the books start: use an opening bill');
});

test('an out-of-state supplier is charged IGST', async () => {
  const bill = (await owner.post('/api/purchases/bills', { supplierId: outside.id, supplierBillNo: 'MI-9', billDate: today, lines: [{ description: 'Ink', quantity: 10, unit: 'kg', rate: 900, gstPercent: 18 }] })).data.data;
  assert.equal(bill.intraState, false);
  assert.equal(bill.igst, 1620);
  assert.equal(bill.cgst + bill.sgst, 0);
});

test('payments: against a bill or oldest first; void puts it back; payables and books agree', async () => {
  await owner.post(`/api/purchases/suppliers/${local.id}/openings`, { number: 'DG/OLD-1', date: '2026-03-15', amount: 10000, dueDate: '2026-03-31' });
  let acc = (await owner.get(`/api/purchases/suppliers/${local.id}/account`)).data.data;
  const owedBefore = acc.summary.outstanding;
  const opening = acc.bills.find((b) => b.kind === 'opening');
  assert.ok(opening.overdueDays > 0);

  // A general payment pays the opening bill first (it fell due first).
  const pay = (await owner.post(`/api/purchases/suppliers/${local.id}/payments`, { amount: 12000, paidAt: today, method: 'bank_transfer', reference: 'NEFT 1' })).data.data;
  acc = (await owner.get(`/api/purchases/suppliers/${local.id}/account`)).data.data;
  assert.equal(acc.bills.find((b) => b.kind === 'opening').balance, 0);
  assert.equal(acc.summary.outstanding, owedBefore - 12000);

  await owner.post(`/api/purchases/payments/${pay.id}/void`, { reason: 'Bounced' });
  acc = (await owner.get(`/api/purchases/suppliers/${local.id}/account`)).data.data;
  assert.equal(acc.summary.outstanding, owedBefore);

  const trial = await tb();
  const payables = (await owner.get('/api/purchases/payables')).data.data;
  const parties = (await owner.get('/api/books/accounts')).data.data.filter((a) => a.supplier);
  for (const row of payables.rows) {
    const party = parties.find((p) => p.supplier === row.id);
    assert.ok(Math.abs(-bal(trial, party.id) - (row.outstanding - row.advance)) < 0.01, `${row.name}: books ${-bal(trial, party.id)} vs payables ${row.outstanding - row.advance}`);
  }
});

test('a debit note lowers the bill and takes the input GST back', async () => {
  const acc0 = (await owner.get(`/api/purchases/suppliers/${local.id}/account`)).data.data;
  const bill = acc0.bills.find((b) => b.kind === 'purchase');
  const before = await tb();
  const note = await owner.post(`/api/purchases/suppliers/${local.id}/debit-notes`, { billId: bill.id, date: today, reason: '20 kg returned (wet)', lines: [{ description: 'LDPE returned', quantity: 20, unit: 'kg', rate: 110, gstPercent: 18 }] });
  assert.equal(note.status, 201, JSON.stringify(note.data));
  assert.equal(note.data.data.total, 2200 + 396);
  const acc1 = (await owner.get(`/api/purchases/suppliers/${local.id}/account`)).data.data;
  assert.equal(acc1.bills.find((b) => b.id === bill.id).balance, bill.balance - 2596);
  const after = await tb();
  assert.equal(bal(after, acct('purchases').id) - bal(before, acct('purchases').id), -2200);
  assert.equal(bal(after, acct('input_cgst').id) - bal(before, acct('input_cgst').id), -198);
  await owner.post(`/api/purchases/debit-notes/${note.data.data.id}/cancel`, { reason: 'Entered wrong' });
  const acc2 = (await owner.get(`/api/purchases/suppliers/${local.id}/account`)).data.data;
  assert.equal(acc2.bills.find((b) => b.id === bill.id).balance, bill.balance);
});

test('a raw material lot without a price takes the bill rate', async () => {
  const stage = await db.collection('inventorystages').findOne({});
  const lot = (await owner.post('/api/inventory/items', { category: 'raw', name: 'HDPE lot 7', materialType: 'HDPE', unit: 'kg', quantity: 300, stageId: String(stage._id), supplierId: local.id })).data.data;
  assert.ok(lot && lot.id, 'lot created');
  await owner.post('/api/purchases/bills', billBody({ supplierBillNo: 'DG/102', lines: [{ description: 'HDPE', quantity: 300, unit: 'kg', rate: 104.5, gstPercent: 18, lot: lot.id }] }));
  const saved = await db.collection('inventoryitems').findOne({ _id: h.asId(lot.id) });
  assert.equal(saved.unitPrice, 104.5);
});

test('supplier accounts cannot be used in manual entries; who can use purchases', async () => {
  const parties = (await owner.get('/api/books/accounts')).data.data.filter((a) => a.supplier);
  const r = await owner.post('/api/books/vouchers', { type: 'journal', date: today, lines: [{ account: parties[0].id, debit: 10 }, { account: acct('cash').id, credit: 10 }] });
  assert.equal(r.status, 400);
  const accountsUser = await h.signIn('accounts');
  assert.equal((await accountsUser.get('/api/purchases/payables')).status, 200);
  const production = await h.signIn('production');
  assert.equal((await production.get('/api/purchases/bills')).status, 403);
  assert.equal((await production.post('/api/purchases/bills', billBody({ supplierBillNo: 'X' }))).status, 403);
});
