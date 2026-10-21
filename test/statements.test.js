const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { setOff } = require('../src/modules/books/books.statements');

let db;
let owner;
let accounts;
let order;
const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const acct = (key) => accounts.find((a) => a.key === key);
const named = (name) => accounts.find((a) => a.name === name);
const r2 = (n) => Math.round(n * 100) / 100;
const tb = async () => (await owner.get(`/api/books/trial-balance?asOf=${today}`)).data.data;
const sumNature = (trial, nature) => r2(trial.groups.filter((g) => g.nature === nature).reduce((s, g) => s + g.debit - g.credit, 0));

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5' });
  await owner.put('/api/books/settings', { startDate: '2026-04-01' });
  accounts = (await owner.get('/api/books/accounts')).data.data;
  order = await db.collection('salesorders').findOne({ status: { $in: ['dispatched', 'delivered', 'completed'] }, 'items.stageWork.stage': 'dispatch' });

  // A small year: capital in, a sale, a purchase bill, rent paid.
  await owner.post('/api/books/vouchers', { type: 'receipt', date: today, narration: 'Capital', lines: [{ account: acct('bank').id, debit: 100000 }, { account: acct('capital').id, credit: 100000 }] });
  const draft = (await owner.get(`/api/billing/orders/${order._id}/invoice-draft`)).data.data;
  const line = draft.lines.find((l) => l.suggested > 0);
  await owner.post(`/api/billing/orders/${order._id}/invoices`, { invoiceDate: today, lines: [{ itemId: line.itemId, quantity: line.suggested }] });
  const supplier = (await owner.post('/api/suppliers', { name: 'Delhi Granules', gstNumber: '07AABCD1234E1Z5' })).data.data;
  await owner.post('/api/purchases/bills', { supplierId: supplier.id, supplierBillNo: 'DG-1', billDate: today, lines: [{ description: 'LDPE', quantity: 100, unit: 'kg', rate: 100, gstPercent: 18 }] });
  await owner.post('/api/bank/expenses', { date: today, paidFrom: acct('bank').id, account: named('Rent').id, amount: 5000 });
});
after(h.stopApp);

test('P&L: income less expenses plus the change in stock; balance sheet balances', async () => {
  const trial = await tb();
  const incomeLessExpense = -r2(sumNature(trial, 'income') + sumNature(trial, 'expense'));
  let pl = (await owner.get(`/api/books/statements/profit-loss?from=2026-04-01&to=${today}`)).data.data;
  assert.equal(pl.trading.closingStock, 0);
  assert.ok(pl.warnings.length, 'closing stock not entered yet');
  assert.equal(pl.netProfit, incomeLessExpense);
  assert.equal(pl.trading.purchases.total, 10000);
  assert.equal(pl.indirectExpenses.accounts.find((a) => a.name === 'Rent').amount, 5000);

  const saved = await owner.put('/api/books/closing-stock', { day: today, value: 4000, note: 'Count' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  pl = (await owner.get(`/api/books/statements/profit-loss?from=2026-04-01&to=${today}`)).data.data;
  assert.equal(pl.trading.closingStock, 4000);
  assert.equal(pl.netProfit, r2(incomeLessExpense + 4000));
  assert.equal(pl.warnings.length, 0);

  const bs = (await owner.get(`/api/books/statements/balance-sheet?asOf=${today}`)).data.data;
  assert.equal(bs.difference, 0, JSON.stringify({ a: bs.totalAssets, l: bs.totalLiabilities }));
  assert.ok(bs.assets.some((g) => g.id === 'stock' && g.total === 4000));
  assert.ok(bs.liabilities.some((g) => g.id === 'capital' && g.total === 100000));
  assert.equal(bs.netProfitThisYear, pl.netProfit);
});

test('cash flow: opening + net = closing, capital is financing', async () => {
  const cf = (await owner.get(`/api/books/statements/cash-flow?from=2026-04-01&to=${today}`)).data.data;
  const trial = await tb();
  const moneyNow = r2(trial.groups.filter((g) => ['bank', 'cash'].includes(g.id)).reduce((s, g) => s + g.debit - g.credit, 0));
  assert.equal(cf.closing, moneyNow);
  assert.equal(cf.check, 0, 'sections add up to the net movement');
  assert.equal(cf.financing.rows.find((r) => r.id === 'capital').inflow, 100000);
  assert.ok(cf.operating.rows.some((r) => r.label === 'Indirect expenses' && r.outflow === 5000));
});

test('GSTR-3B: output tax from invoices, input credit from the books, set-off rules', () => {
  const s = setOff({ igst: 100, cgst: 50, sgst: 50 }, { igst: 120, cgst: 10, sgst: 0 });
  assert.deepEqual(s.cash, { igst: 0, cgst: 20, sgst: 50 });
  assert.deepEqual(s.carried, { igst: 0, cgst: 0, sgst: 0 });
  const t = setOff({ igst: 0, cgst: 10, sgst: 10 }, { igst: 0, cgst: 50, sgst: 0 });
  assert.equal(t.cash.sgst, 10, 'CGST credit never pays SGST');
  assert.equal(t.carried.cgst, 40);
});

test('GSTR-3B for this month', async () => {
  const res = await owner.get(`/api/books/statements/gstr3b?month=${today.slice(0, 7)}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const g = res.data.data;
  const inv = await db.collection('invoices').find({ kind: 'sale', status: 'issued' }).toArray();
  assert.equal(r2(g.outward.cgst + g.outward.sgst + g.outward.igst), r2(inv.reduce((s, i) => s + i.cgst + i.sgst + i.igst, 0)));
  assert.equal(g.itc.cgst, 900);
  assert.equal(g.itc.sgst, 900);
  assert.equal(r2(g.cash.igst + g.used.igst.igst + g.used.cgst.igst + g.used.sgst.igst), g.liability.igst);
});

test('a locked period refuses new entries everywhere; stock accounts are not for hand entries', async () => {
  await owner.put('/api/books/settings', { lockDate: today });
  const customerId = String(order.customer);
  const refusals = await Promise.all([
    owner.post(`/api/billing/customers/${customerId}/receipts`, { amount: 10, receivedAt: today }),
    owner.post('/api/bank/expenses', { date: today, paidFrom: acct('cash').id, account: named('Rent').id, amount: 10 }),
    owner.post(`/api/billing/customers/${customerId}/credit-notes`, { date: today, reason: 'Late test', lines: [{ amount: 10, gstPercent: 0 }] }),
    owner.post('/api/books/vouchers', { type: 'journal', date: today, narration: 'x', lines: [{ account: named('Rent').id, debit: 1 }, { account: acct('capital').id, credit: 1 }] }),
    owner.put('/api/books/closing-stock', { day: today, value: 1 }),
  ]);
  for (const r of refusals) assert.equal(r.status, 400, JSON.stringify(r.data));
  await owner.put('/api/books/settings', { lockDate: '' });

  const stockAccount = (await owner.post('/api/books/accounts', { name: 'Raw material stock', group: 'stock' })).data.data;
  const hand = await owner.post('/api/books/vouchers', { type: 'journal', date: today, narration: 'x', lines: [{ account: stockAccount.id, debit: 1 }, { account: acct('capital').id, credit: 1 }] });
  assert.equal(hand.status, 400);
});

test('closing a year needs its closing stock, locks the year, and only the owner reopens it', async () => {
  assert.equal((await owner.post('/api/books/years/26-27/close')).status, 400, 'year not over');
  await owner.put('/api/books/settings', { startDate: '2025-04-01' });
  assert.equal((await owner.post('/api/books/years/25-26/close')).status, 400, 'closing stock missing');
  await owner.put('/api/books/closing-stock', { day: '2026-03-31', value: 0 });
  const closed = await owner.post('/api/books/years/25-26/close');
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(closed.data.data.closedYears[0].fy, '25-26');
  assert.equal((await owner.get('/api/books/settings')).data.data.lockDate, '2026-03-31');
  const manager = await h.signIn('accounts');
  assert.equal((await manager.post('/api/books/years/25-26/reopen')).status, 403);
  assert.equal((await owner.post('/api/books/years/25-26/reopen')).status, 200);
  assert.equal((await owner.get('/api/books/settings')).data.data.lockDate, '');
  await owner.put('/api/books/settings', { startDate: '2026-04-01' });
});

test('Tally export: ledgers with their groups, vouchers with debits negative and balanced', async () => {
  const masters = await owner.get(`/api/books/export/tally?part=masters&from=2026-04-01&to=${today}`);
  assert.equal(masters.status, 200);
  const mx = String(masters.data);
  assert.match(mx, /<LEDGER NAME="Capital account" ACTION="Create">/);
  assert.match(mx, /<PARENT>Capital Account<\/PARENT>/);
  const vouchers = String((await owner.get(`/api/books/export/tally?part=vouchers&from=2026-04-01&to=${today}`)).data);
  assert.match(vouchers, /<VOUCHER VCHTYPE="Sales" ACTION="Create">/);
  for (const v of vouchers.split('<VOUCHER ').slice(1)) {
    const amounts = [...v.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
    assert.ok(Math.abs(amounts.reduce((s, n) => s + n, 0)) < 0.01, 'each voucher balances');
  }
});
