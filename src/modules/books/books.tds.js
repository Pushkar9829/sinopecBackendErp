const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { hasPermission } = require('../../utils/permissions');
const { businessYmd, endOfBusinessDay } = require('../../utils/businessTime');
const Receipt = require('../billing/receipt.model');
const { SupplierPayment } = require('../purchases/purchase.models');
const { BookAccount, Voucher, BooksSettings } = require('./books.models');
const { syncBooks, systemAccounts } = require('./books.post');

// TDS for a period: what customers deducted from their payments (to claim
// against our income tax, checked with Form 26AS), and what we deducted from
// supplier payments and must deposit with the government.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const YMD = /^\d{4}-\d{2}-\d{2}$/;

async function tdsSummary(user, query = {}) {
  if (!hasPermission(user, 'accounts:read')) throw new ApiError(403, 'You cannot see the books');
  await syncBooks();
  const settings = await BooksSettings.findOne({ key: 'default' }).lean();
  const from = YMD.test(str(query.from)) ? str(query.from) : businessYmd(settings.startDate);
  const to = YMD.test(str(query.to)) ? str(query.to) : businessYmd(new Date());
  if (from > to) throw new ApiError(400, 'The start date is after the end date');
  const range = { $gte: new Date(`${from}T00:00:00+05:30`), $lte: endOfBusinessDay(to) };

  const [receipts, payments] = await Promise.all([
    Receipt.find({ voidedAt: null, tds: { $gt: 0 }, receivedAt: range }).sort({ receivedAt: 1 }).populate('customer', 'name companyName code gstNumber').lean(),
    SupplierPayment.find({ voidedAt: null, tds: { $gt: 0 }, paidAt: range }).sort({ paidAt: 1 }).populate('supplier', 'name code gstNumber').lean(),
  ]);
  const byParty = (rows, partyOf) => {
    const map = new Map();
    for (const r of rows) {
      const p = partyOf(r);
      const key = `${p.id}|${r.tdsSection || ''}`;
      const row = map.get(key) || { partyId: p.id, party: p.name, code: p.code, gstin: p.gstin, section: r.tdsSection || '', count: 0, gross: 0, tds: 0 };
      row.count += 1;
      row.gross = money(row.gross + r.amount + r.tds);
      row.tds = money(row.tds + r.tds);
      map.set(key, row);
    }
    return [...map.values()].sort((a, b) => b.tds - a.tds);
  };
  const customerOf = (r) => ({ id: String(r.customer?._id || r.customer), name: r.customer?.companyName || r.customer?.name || '', code: r.customer?.code || '', gstin: r.customer?.gstNumber || '' });
  const supplierOf = (p) => ({ id: String(p.supplier?._id || p.supplier), name: p.supplier?.name || '', code: p.supplier?.code || '', gstin: p.supplier?.gstNumber || '' });

  // Deposits to the government: hand entries that debit TDS payable.
  const sys = await systemAccounts();
  const payableId = new mongoose.Types.ObjectId(String(sys.tds_payable));
  const deposits = await Voucher.find({ status: 'posted', auto: { $ne: true }, date: range, lines: { $elemMatch: { account: payableId, debit: { $gt: 0 } } } }).sort({ date: 1 }).lean();
  const owed = await Voucher.aggregate([
    { $match: { status: 'posted', date: { $lte: endOfBusinessDay(to) }, 'lines.account': payableId } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': payableId } },
    { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const account = await BookAccount.findById(payableId).lean();
  const owedNow = money((account?.openingCr || 0) - (account?.openingDr || 0) + (owed[0]?.credit || 0) - (owed[0]?.debit || 0));

  return {
    from,
    to,
    accounts: { receivable: String(sys.tds_receivable), payable: String(sys.tds_payable) },
    deductedFromUs: {
      total: money(receipts.reduce((s, r) => s + r.tds, 0)),
      byCustomer: byParty(receipts, customerOf),
      lines: receipts.map((r) => ({ id: String(r._id), date: r.receivedAt, number: r.number, party: customerOf(r).name, section: r.tdsSection, received: r.amount, tds: r.tds })),
    },
    deductedByUs: {
      total: money(payments.reduce((s, p) => s + p.tds, 0)),
      bySupplier: byParty(payments, supplierOf),
      lines: payments.map((p) => ({ id: String(p._id), date: p.paidAt, number: p.number, party: supplierOf(p).name, section: p.tdsSection, paid: p.amount, tds: p.tds })),
      deposited: money(deposits.reduce((s, v) => s + v.lines.filter((l) => String(l.account) === String(payableId)).reduce((t, l) => t + l.debit, 0), 0)),
      deposits: deposits.map((v) => ({ id: String(v._id), date: v.date, number: v.number, narration: v.narration, amount: money(v.lines.filter((l) => String(l.account) === String(payableId)).reduce((t, l) => t + l.debit, 0)) })),
      owedNow,
    },
  };
}

module.exports = { tdsSummary };
