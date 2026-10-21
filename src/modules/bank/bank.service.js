const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { hasPermission, isSuperAdmin } = require('../../utils/permissions');
const { businessYmd, endOfBusinessDay } = require('../../utils/businessTime');
const { BookAccount, Voucher } = require('../books/books.models');
const books = require('../books/books.service');
const { syncBooks } = require('../books/books.post');

// Bank statements: lines imported from the bank's CSV, matched one-to-one to
// entries in the books that touch that bank account. What is left over on
// either side explains the difference between the books and the bank.

const DAY = 24 * 60 * 60 * 1000;
const MATCH_DAYS = 3;
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const actor = (user) => user?.fullName || user?.username || '';

const lineSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'BookAccount', required: true },
    date: { type: Date, required: true },
    description: { type: String, default: '', trim: true },
    reference: { type: String, default: '', trim: true },
    withdrawal: { type: Number, default: 0, min: 0 },
    deposit: { type: Number, default: 0, min: 0 },
    balance: { type: Number, default: null },
    // Same line imported twice is skipped.
    fingerprint: { type: String, required: true },
    batch: { type: String, default: '' },
    status: { type: String, enum: ['unmatched', 'matched', 'ignored'], default: 'unmatched' },
    voucher: { type: mongoose.Schema.Types.ObjectId, ref: 'Voucher', default: null },
    matchedBy: { type: String, default: '' },
    matchedAt: { type: Date, default: null },
    note: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);
lineSchema.index({ account: 1, fingerprint: 1 }, { unique: true });
lineSchema.index({ account: 1, date: 1 });
lineSchema.index({ voucher: 1 }, { unique: true, partialFilterExpression: { voucher: { $type: 'objectId' } } });
const StatementLine = mongoose.models.BankStatementLine || mongoose.model('BankStatementLine', lineSchema);

// ---------------------------------------------------------------- access

const canView = (user) => hasPermission(user, 'accounts:read');
const canWork = (user) => hasPermission(user, 'accounts:create');
const canCorrect = (user) => isSuperAdmin(user) || hasPermission(user, 'accounts:update');
function assert(ok, message) {
  if (!ok) throw new ApiError(403, message);
}

async function moneyAccount(id, { bankOnly = false } = {}) {
  const a = mongoose.isValidObjectId(id) ? await BookAccount.findById(id).lean() : null;
  if (!a || !(bankOnly ? ['bank'] : ['bank', 'cash']).includes(a.group)) throw new ApiError(404, bankOnly ? 'Choose a bank account' : 'Choose a cash or bank account');
  return a;
}

function presentLine(l) {
  return { ...l, id: String(l._id), _id: undefined, __v: undefined, account: String(l.account), voucher: l.voucher ? String(l.voucher) : null, amount: money(l.deposit || -l.withdrawal) };
}

// ---------------------------------------------------------------- accounts & books

// Every cash and bank account with its balance now, and how much of each
// bank's statement is still to be matched.
async function moneyAccounts(user) {
  assert(canView(user), 'You cannot see the books');
  const all = await books.listAccounts(user);
  const rows = all.filter((a) => ['bank', 'cash'].includes(a.group));
  const pending = await StatementLine.aggregate([{ $match: { status: 'unmatched' } }, { $group: { _id: '$account', count: { $sum: 1 } } }]);
  const last = await StatementLine.aggregate([{ $sort: { date: -1, _id: -1 } }, { $group: { _id: '$account', date: { $first: '$date' }, balance: { $first: '$balance' } } }]);
  const pendingBy = new Map(pending.map((p) => [String(p._id), p.count]));
  const lastBy = new Map(last.map((l) => [String(l._id), l]));
  return rows.map((a) => ({
    id: a.id,
    name: a.name,
    group: a.group,
    balance: a.balance,
    isActive: a.isActive,
    unmatched: pendingBy.get(a.id) || 0,
    statementUpTo: lastBy.get(a.id)?.date || null,
    statementBalance: lastBy.get(a.id)?.balance ?? null,
  }));
}

async function addBankAccount(user, payload = {}) {
  assert(canWork(user), 'You cannot add accounts');
  return books.createAccount(user, { name: payload.name, group: payload.group === 'cash' ? 'cash' : 'bank', notes: payload.notes });
}

// ---------------------------------------------------------------- import

function fingerprint(accountId, l) {
  return crypto.createHash('sha1').update([accountId, businessYmd(l.date), l.withdrawal, l.deposit, l.description.toLowerCase().replace(/\s+/g, ' '), l.reference, l.balance ?? ''].join('|')).digest('hex');
}

function parseDate(value) {
  const text = str(value);
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00+05:30`);
  // Indian banks write day first: 05/10/2026, 05-10-26, 05 Oct 2026.
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return new Date(`${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T12:00:00+05:30`);
  }
  m = text.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{2,4})$/);
  if (m) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(m[2].toLowerCase()) + 1;
    if (month > 0) {
      const year = m[3].length === 2 ? `20${m[3]}` : m[3];
      return new Date(`${year}-${String(month).padStart(2, '0')}-${m[1].padStart(2, '0')}T12:00:00+05:30`);
    }
  }
  return null;
}
const amountOf = (v) => {
  const n = Number(String(v ?? '').replace(/[,₹\s]/g, '').replace(/\((.*)\)/, '-$1').replace(/(cr|dr)$/i, ''));
  return Number.isFinite(n) ? n : 0;
};

// Lines arrive already mapped by the screen: { date, description, reference,
// withdrawal, deposit, balance } (or a signed `amount`).
async function importStatement(user, accountId, rows = []) {
  assert(canWork(user), 'You cannot import bank statements');
  const account = await moneyAccount(accountId, { bankOnly: true });
  if (!Array.isArray(rows) || !rows.length) throw new ApiError(400, 'The statement has no lines');
  if (rows.length > 5000) throw new ApiError(400, 'Import at most 5,000 lines at a time');
  const batch = `${Date.now()}`;
  const problems = [];
  const lines = [];
  rows.forEach((r, i) => {
    const date = parseDate(r.date);
    let withdrawal = Math.abs(amountOf(r.withdrawal));
    let deposit = Math.abs(amountOf(r.deposit));
    if (!withdrawal && !deposit && r.amount !== undefined) {
      const a = amountOf(r.amount);
      if (a < 0) withdrawal = -a;
      else deposit = a;
    }
    if (!withdrawal && !deposit) return null; // opening/closing rows, blank rows
    if (!date) return problems.push(`Line ${i + 1}: date "${str(r.date)}" not understood`);
    const line = { account: account._id, date, description: str(r.description).slice(0, 300), reference: str(r.reference).slice(0, 80), withdrawal: money(withdrawal), deposit: money(deposit), balance: str(r.balance) ? money(amountOf(r.balance)) : null, batch };
    line.fingerprint = fingerprint(String(account._id), line);
    lines.push(line);
    return null;
  });
  if (problems.length > 5 && problems.length > rows.length / 2) throw new ApiError(400, `Most dates were not understood. ${problems.slice(0, 3).join('; ')}`);
  let added = 0;
  let duplicates = 0;
  for (const line of lines) {
    try {
      await StatementLine.create(line);
      added += 1;
    } catch (error) {
      if (error?.code === 11000) duplicates += 1;
      else throw error;
    }
  }
  const matched = added ? await autoMatch(user, accountId) : { matched: 0 };
  return { added, duplicates, skipped: problems.length, problems: problems.slice(0, 20), matched: matched.matched };
}

// ---------------------------------------------------------------- matching

// Book entries on this account, as + money in / - money out.
async function bookEntries(accountId, range = {}) {
  await syncBooks();
  const id = new mongoose.Types.ObjectId(String(accountId));
  const date = {};
  if (range.from) date.$gte = range.from;
  if (range.to) date.$lte = range.to;
  const vouchers = await Voucher.find({ status: 'posted', 'lines.account': id, ...(Object.keys(date).length ? { date } : {}) }).sort({ date: 1, _id: 1 }).lean();
  return vouchers.map((v) => {
    const mine = v.lines.filter((l) => String(l.account) === String(id));
    const amount = money(mine.reduce((s, l) => s + l.debit - l.credit, 0));
    return { id: String(v._id), date: v.date, number: v.number, type: v.type, narration: v.narration, sourceRef: v.sourceRef || '', amount };
  });
}

// Pairs each unmatched statement line with one book entry of the same amount
// and direction, closest date first (within 3 days); a cheque/UTR number in
// both breaks ties.
async function autoMatch(user, accountId) {
  assert(canWork(user), 'You cannot match bank lines');
  const account = await moneyAccount(accountId, { bankOnly: true });
  const lines = await StatementLine.find({ account: account._id, status: 'unmatched' }).sort({ date: 1 }).lean();
  if (!lines.length) return { matched: 0 };
  const from = new Date(Math.min(...lines.map((l) => +l.date)) - (MATCH_DAYS + 1) * DAY);
  const to = new Date(Math.max(...lines.map((l) => +l.date)) + (MATCH_DAYS + 1) * DAY);
  const taken = new Set((await StatementLine.find({ account: account._id, voucher: { $ne: null } }, 'voucher').lean()).map((l) => String(l.voucher)));
  const entries = (await bookEntries(account._id, { from, to })).filter((e) => !taken.has(e.id));
  let matched = 0;
  for (const line of lines) {
    const amount = money(line.deposit - line.withdrawal);
    const text = `${line.description} ${line.reference}`.toLowerCase();
    const options = entries
      .filter((e) => !taken.has(e.id) && Math.abs(e.amount - amount) < 0.005 && Math.abs(+e.date - +line.date) <= (MATCH_DAYS + 0.6) * DAY)
      .map((e) => {
        const refs = [e.number, e.sourceRef, ...(e.narration.match(/[A-Za-z0-9]{5,}/g) || [])].map((x) => String(x).toLowerCase());
        return { e, gap: Math.abs(+e.date - +line.date), refHit: refs.some((r) => r.length >= 5 && text.includes(r)) };
      })
      .sort((a, b) => Number(b.refHit) - Number(a.refHit) || a.gap - b.gap);
    if (!options.length) continue;
    const pick = options[0].e;
    const res = await StatementLine.updateOne({ _id: line._id, status: 'unmatched' }, { $set: { status: 'matched', voucher: pick.id, matchedBy: 'Automatic', matchedAt: new Date() } }).catch((error) => (error?.code === 11000 ? null : Promise.reject(error)));
    if (res?.modifiedCount) {
      taken.add(pick.id);
      matched += 1;
    }
  }
  return { matched };
}

async function loadLine(id) {
  const line = mongoose.isValidObjectId(id) ? await StatementLine.findById(id) : null;
  if (!line) throw new ApiError(404, 'Statement line not found');
  return line;
}

// Book entries a statement line could be: same amount and direction, within 15 days.
async function candidates(user, lineId) {
  assert(canView(user), 'You cannot see the books');
  const line = await loadLine(lineId);
  const amount = money(line.deposit - line.withdrawal);
  const taken = new Set((await StatementLine.find({ account: line.account, voucher: { $ne: null } }, 'voucher').lean()).map((l) => String(l.voucher)));
  const entries = await bookEntries(line.account, { from: new Date(+line.date - 15 * DAY), to: new Date(+line.date + 15 * DAY) });
  return entries.filter((e) => !taken.has(e.id) && Math.abs(e.amount - amount) < 0.005).sort((a, b) => Math.abs(+a.date - +line.date) - Math.abs(+b.date - +line.date));
}

async function matchLine(user, lineId, voucherId) {
  assert(canWork(user), 'You cannot match bank lines');
  const line = await loadLine(lineId);
  if (line.status === 'matched') throw new ApiError(400, 'Already matched; unmatch it first');
  const options = await candidates(user, lineId);
  if (!options.some((e) => e.id === String(voucherId))) throw new ApiError(400, 'That entry is not the same amount, is too far apart in date, or is already matched');
  line.status = 'matched';
  line.voucher = voucherId;
  line.matchedBy = actor(user);
  line.matchedAt = new Date();
  await line.save();
  return presentLine(line.toObject());
}

async function unmatchLine(user, lineId) {
  assert(canWork(user), 'You cannot match bank lines');
  const line = await loadLine(lineId);
  line.status = 'unmatched';
  line.voucher = null;
  line.matchedBy = '';
  line.matchedAt = null;
  await line.save();
  return presentLine(line.toObject());
}

async function ignoreLine(user, lineId, note) {
  assert(canWork(user), 'You cannot change bank lines');
  const line = await loadLine(lineId);
  if (line.status === 'matched') throw new ApiError(400, 'Unmatch it first');
  line.status = line.status === 'ignored' ? 'unmatched' : 'ignored';
  line.note = str(note);
  await line.save();
  return presentLine(line.toObject());
}

// Bank charges, interest and the like are only on the statement: make the
// entry from the line (bank against the chosen account) and match it.
async function entryFromLine(user, lineId, payload = {}) {
  assert(canWork(user), 'You cannot make entries');
  const line = await loadLine(lineId);
  if (line.status === 'matched') throw new ApiError(400, 'Already matched');
  if (!mongoose.isValidObjectId(payload.account)) throw new ApiError(400, 'Choose the account (e.g. Bank charges)');
  const amount = money(line.deposit || line.withdrawal);
  const isIn = line.deposit > 0;
  const voucher = await books.createVoucher(user, {
    type: isIn ? 'receipt' : 'payment',
    date: businessYmd(line.date),
    narration: str(payload.narration) || `${line.description}${line.reference ? ` (${line.reference})` : ''}`.slice(0, 200),
    lines: isIn
      ? [
          { account: String(line.account), debit: amount },
          { account: payload.account, credit: amount },
        ]
      : [
          { account: payload.account, debit: amount },
          { account: String(line.account), credit: amount },
        ],
  });
  line.status = 'matched';
  line.voucher = voucher.id;
  line.matchedBy = actor(user);
  line.matchedAt = new Date();
  await line.save();
  return { line: presentLine(line.toObject()), voucher };
}

async function listLines(user, accountId, query = {}) {
  assert(canView(user), 'You cannot see the books');
  const account = await moneyAccount(accountId, { bankOnly: true });
  const filter = { account: account._id };
  if (['unmatched', 'matched', 'ignored'].includes(query.status)) filter.status = query.status;
  const range = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(query.from))) range.$gte = new Date(`${query.from}T00:00:00+05:30`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(query.to))) range.$lte = endOfBusinessDay(str(query.to));
  if (Object.keys(range).length) filter.date = range;
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 50));
  const page = Math.max(1, Number(query.page) || 1);
  const [total, docs, counts] = await Promise.all([
    StatementLine.countDocuments(filter),
    StatementLine.find(filter).sort({ date: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    StatementLine.aggregate([{ $match: { account: account._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
  ]);
  const vouchers = new Map((await Voucher.find({ _id: { $in: docs.map((d) => d.voucher).filter(Boolean) } }, 'number type narration date').lean()).map((v) => [String(v._id), v]));
  return {
    items: docs.map((d) => ({ ...presentLine(d), matchedEntry: d.voucher ? vouchers.get(String(d.voucher)) || null : null })),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    counts: Object.fromEntries(counts.map((c) => [c._id, c.count])),
  };
}

// Bank reconciliation: balance in the books, entries not yet in the bank,
// bank lines not yet in the books, and the bank's own balance.
async function reconciliation(user, accountId, query = {}) {
  assert(canView(user), 'You cannot see the books');
  const account = await moneyAccount(accountId, { bankOnly: true });
  const asOfYmd = /^\d{4}-\d{2}-\d{2}$/.test(str(query.asOf)) ? str(query.asOf) : businessYmd(new Date());
  const asOf = endOfBusinessDay(asOfYmd);
  const ledger = await books.ledger(user, String(account._id), { to: asOfYmd, from: '2000-01-01' });
  const bookBalance = ledger.closing;
  const lines = await StatementLine.find({ account: account._id, date: { $lte: asOf } }).sort({ date: 1, _id: 1 }).lean();
  const matchedIds = new Set(lines.filter((l) => l.voucher).map((l) => String(l.voucher)));
  const firstStatement = lines[0]?.date || null;
  // Book entries since the statement starts that the bank has not shown yet.
  const entries = firstStatement ? (await bookEntries(account._id, { from: new Date(+firstStatement - 15 * DAY), to: asOf })).filter((e) => !matchedIds.has(e.id)) : [];
  const notInBank = entries.map((e) => ({ ...e, kind: e.amount > 0 ? 'Deposited, not yet credited by the bank' : 'Paid, not yet debited by the bank (e.g. cheque not cleared)' }));
  const notInBooks = lines.filter((l) => l.status === 'unmatched').map(presentLine);
  const lastWithBalance = [...lines].reverse().find((l) => l.balance !== null && l.balance !== undefined);
  const inBankNotBooks = money(notInBooks.reduce((s, l) => s + l.amount, 0));
  const inBooksNotBank = money(notInBank.reduce((s, e) => s + e.amount, 0));
  const expectedBank = money(bookBalance - inBooksNotBank + inBankNotBooks);
  return {
    account: { id: String(account._id), name: account.name },
    asOf: asOfYmd,
    bookBalance,
    notInBank,
    inBooksNotBank,
    notInBooks,
    inBankNotBooks,
    ignored: lines.filter((l) => l.status === 'ignored').length,
    expectedBank,
    statementBalance: lastWithBalance ? money(lastWithBalance.balance) : null,
    statementBalanceDate: lastWithBalance?.date || null,
    difference: lastWithBalance ? money(money(lastWithBalance.balance) - expectedBank) : null,
    statementFrom: firstStatement,
  };
}

async function deleteBatch(user, accountId, batch) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can remove an imported statement');
  const account = await moneyAccount(accountId, { bankOnly: true });
  const res = await StatementLine.deleteMany({ account: account._id, batch: str(batch) });
  return { removed: res.deletedCount };
}

module.exports = {
  StatementLine,
  moneyAccounts,
  addBankAccount,
  importStatement,
  autoMatch,
  candidates,
  matchLine,
  unmatchLine,
  ignoreLine,
  entryFromLine,
  listLines,
  reconciliation,
  deleteBatch,
  parseDate,
};
