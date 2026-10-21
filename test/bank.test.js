const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let owner;
let accounts;
const ymd = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600 * 1000 + offsetDays * 864e5).toISOString().slice(0, 10);
const today = ymd();
const dmy = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
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
  await h.startApp();
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  await owner.put('/api/books/settings', { startDate: '2026-04-01' });
  accounts = (await owner.get('/api/books/accounts')).data.data;
});
after(h.stopApp);

test('a quick expense: head, input GST and cash move together, and it lists with totals', async () => {
  const before = await tb();
  const options = (await owner.get('/api/bank/expenses/options')).data.data;
  assert.ok(options.heads.some((x) => x.name === 'Rent') && options.moneyAccounts.some((x) => x.id === acct('cash').id));
  const res = await owner.post('/api/bank/expenses', { date: today, paidFrom: acct('cash').id, account: named('Rent').id, amount: 10000, gst: { mode: 'intra', rate: 18 }, paidTo: 'Sharma Estates', billNo: 'R-77' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.data.total, 11800);
  const after = await tb();
  assert.equal(bal(after, named('Rent').id) - bal(before, named('Rent').id), 10000);
  assert.equal(bal(after, acct('input_cgst').id) - bal(before, acct('input_cgst').id), 900);
  assert.equal(bal(after, acct('input_sgst').id) - bal(before, acct('input_sgst').id), 900);
  assert.equal(bal(after, acct('cash').id) - bal(before, acct('cash').id), -11800);
  assert.equal(after.difference, after.openingDifference);

  await owner.post('/api/bank/expenses', { date: today, paidFrom: acct('bank').id, account: named('Freight & cartage').id, amount: 2000, gst: { mode: 'inter', rate: 5 }, paidTo: 'Fast Movers' });
  const list = (await owner.get(`/api/bank/expenses?from=${today}&to=${today}`)).data.data;
  assert.equal(list.total, 2);
  assert.equal(list.summary.amount, 12000);
  assert.equal(list.summary.gst, 1900);
  assert.equal(list.items.find((x) => x.paidTo === 'Fast Movers').gst, 100);
  assert.equal(list.items.find((x) => x.billNo === 'R-77').paidFrom, 'Cash in hand');
  const search = (await owner.get(`/api/bank/expenses?q=sharma`)).data.data;
  assert.equal(search.total, 1);

  const wrong = await owner.post('/api/bank/expenses', { date: today, paidFrom: acct('cash').id, account: acct('sales').id, amount: 10 });
  assert.equal(wrong.status, 400, 'sales is not an expense head');
  const badRate = await owner.post('/api/bank/expenses', { date: today, paidFrom: acct('cash').id, account: named('Rent').id, amount: 10, gst: { mode: 'intra', rate: 7 } });
  assert.equal(badRate.status, 400);
  const production = await h.signIn('production');
  assert.equal((await production.post('/api/bank/expenses', { date: today, paidFrom: acct('cash').id, account: named('Rent').id, amount: 10 })).status, 403);
});

test('bank statement: import, skip duplicates, match automatically and by hand, book what only the bank has, reconcile', async () => {
  const bank = acct('bank').id;
  // In the books: a customer-style receipt into bank, an expense paid by bank,
  // a cheque not yet cleared, and interest that the bank shows days later.
  const rv = (amount, credit, narration) => owner.post('/api/books/vouchers', { type: 'receipt', date: today, narration, lines: [{ account: bank, debit: amount }, { account: credit, credit: amount }] });
  const inRes = await rv(1500, acct('capital').id, 'Capital brought in UTR778812');
  assert.equal(inRes.status, 201, JSON.stringify(inRes.data));
  await owner.post('/api/bank/expenses', { date: today, paidFrom: bank, account: named('Power & fuel').id, amount: 5000, gst: { mode: 'intra', rate: 18 } });
  await owner.post('/api/bank/expenses', { date: today, paidFrom: bank, account: named('Repairs & maintenance').id, amount: 3000, narration: 'Cheque 000123 to Mehta Engg' });
  const interest = (await rv(700, named('Interest received').id, 'FD interest')).data.data;

  const rows = [
    { date: dmy(today), description: 'NEFT CR UTR778812 OWNER', deposit: '1,500.00' },
    { date: dmy(today), description: 'BILLDESK ELECTRICITY', withdrawal: '5,900.00' },
    { date: dmy(today), description: 'SMS CHARGES', withdrawal: '250' },
    { date: dmy(ymd(5)), description: 'INT.PD', deposit: '700.00', balance: '99,999.00' },
    { date: 'Opening balance', description: '', deposit: '' },
  ];
  const first = await owner.post(`/api/bank/accounts/${bank}/statement`, { rows: rows.slice(0, 4) });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.data.added, 4);
  assert.equal(first.data.data.matched, 2, 'receipt and electricity match by amount and date; interest is 5 days off');
  const again = (await owner.post(`/api/bank/accounts/${bank}/statement`, { rows: rows.slice(0, 4) })).data.data;
  assert.equal(again.added, 0);
  assert.equal(again.duplicates, 4);

  const lines = (await owner.get(`/api/bank/accounts/${bank}/statement`)).data.data;
  assert.equal(lines.counts.matched, 2);
  assert.equal(lines.counts.unmatched, 2);
  const intLine = lines.items.find((l) => l.deposit === 700);
  const chargeLine = lines.items.find((l) => l.withdrawal === 250);
  assert.equal(lines.items.find((l) => l.deposit === 1500).matchedEntry.number, inRes.data.data.number);

  const options = (await owner.get(`/api/bank/lines/${intLine.id}/candidates`)).data.data;
  assert.deepEqual(options.map((o) => o.id), [interest.id]);
  const wrongPick = await owner.post(`/api/bank/lines/${chargeLine.id}/match`, { voucherId: interest.id });
  assert.equal(wrongPick.status, 400, 'amounts differ');
  assert.equal((await owner.post(`/api/bank/lines/${intLine.id}/match`, { voucherId: interest.id })).data.data.status, 'matched');
  assert.equal((await owner.post(`/api/bank/lines/${intLine.id}/unmatch`)).data.data.status, 'unmatched');
  assert.equal((await owner.post(`/api/bank/lines/${intLine.id}/match`, { voucherId: interest.id })).data.data.status, 'matched');

  let rec = (await owner.get(`/api/bank/accounts/${bank}/reconciliation?asOf=${ymd(5)}`)).data.data;
  assert.equal(rec.inBankNotBooks, -250, 'bank charges are only in the bank');
  assert.ok(rec.notInBank.some((e) => e.amount === -3000), 'the uncleared cheque');
  assert.equal(rec.expectedBank, Math.round((rec.bookBalance - rec.inBooksNotBank + rec.inBankNotBooks) * 100) / 100);
  assert.equal(rec.statementBalance, 99999);

  const before = await tb();
  const made = await owner.post(`/api/bank/lines/${chargeLine.id}/entry`, { account: named('Bank charges').id });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const after = await tb();
  assert.equal(bal(after, named('Bank charges').id) - bal(before, named('Bank charges').id), 250);
  assert.equal(bal(after, bank) - bal(before, bank), -250);
  rec = (await owner.get(`/api/bank/accounts/${bank}/reconciliation?asOf=${ymd(5)}`)).data.data;
  assert.equal(rec.inBankNotBooks, 0);
  assert.equal(rec.notInBooks.length, 0);

  // Ignoring toggles; a matched line must be unmatched first.
  assert.equal((await owner.post(`/api/bank/lines/${intLine.id}/ignore`)).status, 400);
  const money = (await owner.get('/api/bank/accounts')).data.data;
  const row = money.find((a) => a.id === bank);
  assert.equal(row.unmatched, 0);
  assert.equal(row.statementBalance, 99999);

  const production = await h.signIn('production');
  assert.equal((await production.post(`/api/bank/accounts/${bank}/statement`, { rows })).status, 403);
  assert.equal((await owner.post(`/api/bank/accounts/${acct('cash').id}/statement`, { rows })).status, 404, 'statements are for bank accounts');
});

test('a second bank account can be added and has its own book', async () => {
  const res = await owner.post('/api/bank/accounts', { name: 'HDFC current a/c' });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const hdfc = res.data.data.id;
  const contra = await owner.post('/api/books/vouchers', { type: 'contra', date: today, narration: 'Transfer', lines: [{ account: hdfc, debit: 2500 }, { account: acct('bank').id, credit: 2500 }] });
  assert.equal(contra.status, 201, JSON.stringify(contra.data));
  const money = (await owner.get('/api/bank/accounts')).data.data;
  assert.equal(money.find((a) => a.id === hdfc).balance, 2500);
  assert.equal(money.find((a) => a.id === hdfc).group, 'bank');
});
