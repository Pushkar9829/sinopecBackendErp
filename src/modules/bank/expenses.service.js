const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { hasPermission } = require('../../utils/permissions');
const { businessYmd, endOfBusinessDay } = require('../../utils/businessTime');
const { BookAccount, Voucher } = require('../books/books.models');
const books = require('../books/books.service');
const { systemAccounts } = require('../books/books.post');

// Quick expense entry: a payment voucher (expense head + input GST against
// cash or bank) with who was paid and their bill number kept alongside.

const HEAD_GROUPS = ['direct_expenses', 'indirect_expenses', 'fixed_assets', 'purchases', 'loans_advances', 'deposits'];
const GST_RATES = [0, 5, 12, 18, 28];
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function assert(ok, message) {
  if (!ok) throw new ApiError(403, message);
}

// GST on the bill: none, CGST+SGST (same state) or IGST (other state).
function taxOf(amount, gst = {}) {
  const rate = Number(gst.rate) || 0;
  if (!rate || !['intra', 'inter'].includes(gst.mode)) return { cgst: 0, sgst: 0, igst: 0, rate: 0, mode: 'none' };
  if (!GST_RATES.includes(rate)) throw new ApiError(400, `GST rate must be one of ${GST_RATES.join(', ')}`);
  if (gst.mode === 'inter') return { cgst: 0, sgst: 0, igst: money((amount * rate) / 100), rate, mode: 'inter' };
  const half = money((amount * rate) / 200);
  return { cgst: half, sgst: half, igst: 0, rate, mode: 'intra' };
}

async function createExpense(user, payload = {}) {
  assert(hasPermission(user, 'accounts:create'), 'You cannot enter expenses');
  const amount = money(payload.amount);
  if (amount <= 0) throw new ApiError(400, 'Enter the amount (before GST)');
  const [head, from] = await Promise.all(
    [payload.account, payload.paidFrom].map((id) => (mongoose.isValidObjectId(id) ? BookAccount.findById(id).lean() : null))
  );
  if (!head || !HEAD_GROUPS.includes(head.group)) throw new ApiError(400, 'Choose what the money was spent on (an expense head)');
  if (!from || !['cash', 'bank'].includes(from.group)) throw new ApiError(400, 'Choose the cash or bank account it was paid from');
  const tax = taxOf(amount, payload.gst);
  const sys = await systemAccounts();
  const total = money(amount + tax.cgst + tax.sgst + tax.igst);
  const paidTo = str(payload.paidTo).slice(0, 120);
  const billNo = str(payload.billNo).slice(0, 60);
  const lines = [
    { account: String(head._id), debit: amount },
    { account: String(sys.input_cgst), debit: tax.cgst },
    { account: String(sys.input_sgst), debit: tax.sgst },
    { account: String(sys.input_igst), debit: tax.igst },
    { account: String(from._id), credit: total },
  ];
  const narration = str(payload.narration) || [head.name, paidTo && `paid to ${paidTo}`, billNo && `bill ${billNo}`, tax.rate ? `GST ${tax.rate}%` : ''].filter(Boolean).join(' · ');
  const voucher = await books.createVoucher(user, { type: 'payment', date: payload.date, narration, lines });
  await Voucher.updateOne({ _id: voucher.id }, { $set: { kind: 'expense', paidTo, billNo } });
  return { ...voucher, kind: 'expense', paidTo, billNo };
}

// Expense list for a period with totals per head; paged.
async function listExpenses(user, query = {}) {
  assert(hasPermission(user, 'accounts:read'), 'You cannot see the books');
  const settings = await books.getSettings(user);
  const from = YMD.test(str(query.from)) ? str(query.from) : settings.startDate || '2000-01-01';
  const to = YMD.test(str(query.to)) ? str(query.to) : businessYmd(new Date());
  const filter = { kind: 'expense', date: { $gte: new Date(`${from}T00:00:00+05:30`), $lte: endOfBusinessDay(to) } };
  if (query.status === 'cancelled') filter.status = 'cancelled';
  else filter.status = 'posted';
  if (mongoose.isValidObjectId(query.account)) filter['lines.account'] = new mongoose.Types.ObjectId(String(query.account));
  if (str(query.q)) {
    const rx = new RegExp(str(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ paidTo: rx }, { billNo: rx }, { narration: rx }, { number: rx }];
  }
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));
  const page = Math.max(1, Number(query.page) || 1);
  const [total, docs, all, accounts] = await Promise.all([
    Voucher.countDocuments(filter),
    Voucher.find(filter).sort({ date: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Voucher.find(filter, 'lines').lean(),
    BookAccount.find({}, 'name group key').lean(),
  ]);
  const byId = new Map(accounts.map((a) => [String(a._id), a]));
  const isTax = (id) => ['input_cgst', 'input_sgst', 'input_igst'].includes(byId.get(id)?.key);
  const isMoney = (id) => ['cash', 'bank'].includes(byId.get(id)?.group);
  const shape = (v) => {
    const lines = v.lines.map((l) => ({ ...l, account: String(l.account) }));
    const heads = lines.filter((l) => l.debit > 0 && !isTax(l.account) && !isMoney(l.account));
    const paid = lines.find((l) => l.credit > 0 && isMoney(l.account));
    return {
      id: String(v._id),
      number: v.number,
      date: v.date,
      head: heads.map((l) => byId.get(l.account)?.name || '').join(', '),
      headId: heads[0]?.account || null,
      amount: money(heads.reduce((s, l) => s + l.debit, 0)),
      gst: money(lines.filter((l) => isTax(l.account)).reduce((s, l) => s + l.debit, 0)),
      total: v.total,
      paidFrom: paid ? byId.get(paid.account)?.name || '' : '',
      paidTo: v.paidTo || '',
      billNo: v.billNo || '',
      narration: v.narration,
      status: v.status,
      cancelReason: v.cancelReason || '',
    };
  };
  const byHead = new Map();
  let sumAmount = 0;
  let sumGst = 0;
  for (const v of all.map(shape)) {
    sumAmount += v.amount;
    sumGst += v.gst;
    const row = byHead.get(v.head) || { head: v.head, count: 0, amount: 0 };
    row.count += 1;
    row.amount = money(row.amount + v.amount);
    byHead.set(v.head, row);
  }
  return {
    from,
    to,
    items: docs.map(shape),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    summary: { amount: money(sumAmount), gst: money(sumGst), total: money(sumAmount + sumGst), byHead: [...byHead.values()].sort((a, b) => b.amount - a.amount) },
  };
}

async function formOptions(user) {
  assert(hasPermission(user, 'accounts:read'), 'You cannot see the books');
  const accounts = await books.listAccounts(user, { withBalances: false });
  return {
    heads: accounts.filter((a) => HEAD_GROUPS.includes(a.group) && a.isActive !== false && !['purchases', 'round_off'].includes(a.key)).map((a) => ({ id: a.id, name: a.name, group: a.group, groupLabel: a.groupLabel })),
    moneyAccounts: accounts.filter((a) => ['cash', 'bank'].includes(a.group) && a.isActive !== false).map((a) => ({ id: a.id, name: a.name, group: a.group })),
    gstRates: GST_RATES,
  };
}

module.exports = { createExpense, listExpenses, formOptions, taxOf, HEAD_GROUPS };
