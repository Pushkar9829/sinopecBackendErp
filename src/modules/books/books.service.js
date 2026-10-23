const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { hasPermission, isSuperAdmin } = require('../../utils/permissions');
const { nextSeq } = require('../../utils/counter');
const { businessYmd, endOfBusinessDay } = require('../../utils/businessTime');
const Invoice = require('../billing/invoice.model');
const { PurchaseBill } = require('../purchases/purchase.models');
const { BookAccount, Voucher, BooksSettings, YearClose } = require('./books.models');
const { assertOpeningsOpen } = require('./books.lock');
const { GROUPS, GROUP_BY_ID, natureOf } = require('./books.chart');
const { ensureChart, syncBooks } = require('./books.post');

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const EPS = 0.005;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MANUAL_TYPES = { journal: 'JV', contra: 'CV', payment: 'PV', receipt: 'RV' };
const TYPE_LABEL = { sales: 'Sales', receipt: 'Receipt', payment: 'Payment', journal: 'Journal', contra: 'Contra', purchase: 'Purchase', credit_note: 'Credit note', debit_note: 'Debit note' };
const MONEY_GROUPS = ['bank', 'cash'];

// ---------------------------------------------------------------- access

const canView = (user) => hasPermission(user, 'accounts:read');
const canPost = (user) => hasPermission(user, 'accounts:create');
const canCorrect = (user) => isSuperAdmin(user) || hasPermission(user, 'accounts:update');
function assert(ok, message) {
  if (!ok) throw new ApiError(403, message);
}

// ---------------------------------------------------------------- helpers

const startOfDay = (ymd) => new Date(`${ymd}T00:00:00.000+05:30`);
function parseDay(value, label) {
  const text = str(value);
  if (!YMD.test(text)) throw new ApiError(400, `${label} must be a date (YYYY-MM-DD)`);
  return text;
}
function fyOf(date) {
  const ymd = businessYmd(date);
  const year = Number(ymd.slice(0, 4));
  const start = Number(ymd.slice(5, 7)) >= 4 ? year : year - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}
async function settingsDoc() {
  await ensureChart();
  return BooksSettings.findOne({ key: 'default' }).lean();
}
function present(account) {
  const group = GROUP_BY_ID.get(account.group);
  return {
    id: String(account._id),
    name: account.name,
    group: account.group,
    groupLabel: group?.label || account.group,
    nature: natureOf(account.group),
    key: account.key || null,
    system: Boolean(account.key),
    customer: account.customer ? String(account.customer) : null,
    supplier: account.supplier ? String(account.supplier) : null,
    party: Boolean(account.customer || account.supplier),
    openingDr: account.openingDr || 0,
    openingCr: account.openingCr || 0,
    isActive: account.isActive !== false,
    notes: account.notes || '',
  };
}

// Opening balance of each customer account: their opening bills (unpaid bills
// from before the app) count as what they owed on the start date.
async function customerOpenings() {
  const rows = await Invoice.aggregate([{ $match: { kind: 'opening', status: 'issued' } }, { $group: { _id: '$customer', total: { $sum: '$total' } } }]);
  return new Map(rows.map((r) => [String(r._id), money(r.total)]));
}

// What the plant owed each supplier on the start date: their opening bills.
async function supplierOpenings() {
  const rows = await PurchaseBill.aggregate([{ $match: { kind: 'opening', status: 'issued' } }, { $group: { _id: '$supplier', total: { $sum: '$total' } } }]);
  return new Map(rows.map((r) => [String(r._id), money(r.total)]));
}

// Net opening (debit positive) of every account.
async function openingByAccount(accounts) {
  const [fromBills, owedToSuppliers] = await Promise.all([customerOpenings(), supplierOpenings()]);
  const map = new Map();
  for (const a of accounts) {
    const bills = a.customer ? fromBills.get(String(a.customer)) || 0 : 0;
    const owed = a.supplier ? owedToSuppliers.get(String(a.supplier)) || 0 : 0;
    map.set(String(a._id), money((a.openingDr || 0) - (a.openingCr || 0) + bills - owed));
  }
  return map;
}

// Sum of debits and credits per account over posted vouchers in a date range.
async function movements({ before, from, to, account } = {}) {
  const date = {};
  if (from) date.$gte = from;
  if (to) date.$lte = to;
  if (before) date.$lt = before;
  const match = { status: 'posted', ...(Object.keys(date).length ? { date } : {}) };
  const pipeline = [{ $match: match }, { $unwind: '$lines' }];
  if (account) pipeline.push({ $match: { 'lines.account': account } });
  pipeline.push({ $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } });
  const rows = await Voucher.aggregate(pipeline);
  return new Map(rows.map((r) => [String(r._id), { debit: money(r.debit), credit: money(r.credit) }]));
}

// ---------------------------------------------------------------- settings

async function getSettings(user) {
  assert(canView(user), 'You cannot see the books');
  const s = await settingsDoc();
  return { startDate: businessYmd(s.startDate), lockDate: s.lockDate ? businessYmd(s.lockDate) : '', defaultBank: s.defaultBank ? String(s.defaultBank) : null, groups: GROUPS };
}

async function saveSettings(user, payload = {}) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can change the books settings');
  const s = await settingsDoc();
  const set = {};
  if (payload.startDate !== undefined) {
    const start = startOfDay(parseDay(payload.startDate, 'Start date'));
    if (s.lockDate && start.getTime() !== new Date(s.startDate).getTime()) throw new ApiError(400, 'The books are locked; unlock them before changing the start date');
    set.startDate = start;
  }
  if (payload.lockDate !== undefined) {
    const next = str(payload.lockDate) ? endOfBusinessDay(parseDay(payload.lockDate, 'Lock date')) : null;
    // A closed year stays locked until the owner reopens it; only the owner moves the lock back.
    const closed = await YearClose.findOne({}).sort({ fy: -1 }).lean();
    if (closed && (!next || next < endOfBusinessDay(closed.endDay))) throw new ApiError(400, `${closed.fy} is closed and stays locked to ${closed.endDay}; the owner can reopen it under Statements → year end`);
    if (!isSuperAdmin(user) && s.lockDate && (!next || next < s.lockDate)) throw new ApiError(403, 'Only the owner can move the lock date back');
    set.lockDate = next;
  }
  if (payload.defaultBank !== undefined) {
    const bank = mongoose.isValidObjectId(payload.defaultBank) ? await BookAccount.findById(payload.defaultBank).lean() : null;
    if (!bank || bank.group !== 'bank') throw new ApiError(400, 'Choose a bank account');
    set.defaultBank = bank._id;
  }
  // Bring the books up to date first: older receipts get their account fixed
  // (the bank in use until now), and nothing waiting is left out of a period
  // about to be locked. A new default bank only applies to money received after.
  const bankChanges = set.defaultBank && String(set.defaultBank) !== String(s.defaultBank || '');
  if (bankChanges || set.lockDate) await syncBooks({ full: true });
  await BooksSettings.updateOne({ _id: s._id }, { $set: set });
  return getSettings(user);
}

// ---------------------------------------------------------------- accounts

async function listAccounts(user, { withBalances = true } = {}) {
  assert(canView(user), 'You cannot see the books');
  await syncBooks();
  const accounts = await BookAccount.find({}).sort({ group: 1, name: 1 }).lean();
  const rows = accounts.map(present);
  if (!withBalances) return rows;
  const openings = await openingByAccount(accounts);
  const moves = await movements({});
  for (const row of rows) {
    const m = moves.get(row.id) || { debit: 0, credit: 0 };
    row.opening = openings.get(row.id) || 0;
    row.balance = money(row.opening + m.debit - m.credit);
    row.used = Boolean(moves.get(row.id)) || row.opening !== 0;
  }
  return rows;
}

async function createAccount(user, payload = {}) {
  assert(canPost(user), 'You cannot add accounts');
  await ensureChart();
  const name = str(payload.name);
  if (name.length < 2) throw new ApiError(400, 'Give the account a name');
  if (!GROUP_BY_ID.has(payload.group) || payload.group === 'sundry_debtors') throw new ApiError(400, 'Choose a group (customer accounts are made automatically)');
  if (await BookAccount.exists({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })) throw new ApiError(409, 'An account with this name already exists');
  const doc = await BookAccount.create({ name, group: payload.group, notes: str(payload.notes), openingDr: Math.max(0, money(payload.openingDr)), openingCr: Math.max(0, money(payload.openingCr)) });
  return present(doc.toObject());
}

async function updateAccount(user, id, payload = {}) {
  assert(canPost(user), 'You cannot change accounts');
  const account = mongoose.isValidObjectId(id) ? await BookAccount.findById(id) : null;
  if (!account) throw new ApiError(404, 'Account not found');
  if (payload.name !== undefined && !account.customer) {
    const name = str(payload.name);
    if (name.length < 2) throw new ApiError(400, 'Give the account a name');
    account.name = name;
  }
  if (payload.group !== undefined && payload.group !== account.group) {
    if (account.key || account.customer || account.supplier) throw new ApiError(400, 'This account is used by the app; its group cannot change');
    if (!GROUP_BY_ID.has(payload.group) || payload.group === 'sundry_debtors') throw new ApiError(400, 'Choose a group');
    account.group = payload.group;
  }
  if (payload.notes !== undefined) account.notes = str(payload.notes);
  if (payload.isActive !== undefined) {
    if (account.key && payload.isActive === false) throw new ApiError(400, 'This account is used by the app and stays active');
    account.isActive = Boolean(payload.isActive);
  }
  if (payload.openingDr !== undefined || payload.openingCr !== undefined) {
    assert(canCorrect(user), 'Only Accounts managers and the owner can change opening balances');
    if (account.customer || account.supplier) throw new ApiError(400, 'A customer or supplier opening balance comes from their opening bills');
    if (money(payload.openingDr ?? account.openingDr) !== money(account.openingDr) || money(payload.openingCr ?? account.openingCr) !== money(account.openingCr)) await assertOpeningsOpen();
    account.openingDr = Math.max(0, money(payload.openingDr ?? account.openingDr));
    account.openingCr = Math.max(0, money(payload.openingCr ?? account.openingCr));
  }
  await account.save();
  return present(account.toObject());
}

async function deleteAccount(user, id) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can delete accounts');
  const account = mongoose.isValidObjectId(id) ? await BookAccount.findById(id).lean() : null;
  if (!account) throw new ApiError(404, 'Account not found');
  if (account.key || account.customer || account.supplier) throw new ApiError(400, 'This account is used by the app and cannot be deleted');
  if (account.openingDr || account.openingCr || (await Voucher.exists({ 'lines.account': account._id }))) throw new ApiError(409, 'This account has entries; make it inactive instead');
  await BookAccount.deleteOne({ _id: account._id });
  return { deleted: true };
}

// Opening balances for many accounts at once: [{ accountId, debit, credit }].
async function saveOpenings(user, rows = []) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can change opening balances');
  if (!Array.isArray(rows)) throw new ApiError(400, 'Send a list of opening balances');
  await assertOpeningsOpen();
  for (const row of rows) {
    if (!mongoose.isValidObjectId(row.accountId)) continue;
    const debit = Math.max(0, money(row.debit));
    const credit = Math.max(0, money(row.credit));
    if (debit > 0 && credit > 0) throw new ApiError(400, 'An opening balance is either debit or credit, not both');
    await BookAccount.updateOne({ _id: row.accountId, customer: { $exists: false }, supplier: { $exists: false } }, { $set: { openingDr: debit, openingCr: credit } });
  }
  return trialBalance(user, {});
}

// ---------------------------------------------------------------- vouchers

function presentVoucher(v, names) {
  return {
    id: String(v._id),
    type: v.type,
    typeLabel: TYPE_LABEL[v.type] || v.type,
    number: v.number,
    date: v.date,
    narration: v.narration,
    total: v.total,
    status: v.status,
    auto: v.auto,
    sourceRef: v.sourceRef || '',
    sourceLink: v.sourceLink || '',
    createdByName: v.createdByName || (v.auto ? 'Automatic' : ''),
    cancelReason: v.cancelReason || '',
    lines: v.lines.map((l) => ({ account: String(l.account), accountName: names.get(String(l.account)) || '?', debit: l.debit, credit: l.credit, note: l.note || '' })),
  };
}

async function accountNames() {
  return new Map((await BookAccount.find({}, 'name').lean()).map((a) => [String(a._id), a.name]));
}

function dateRange(query, settings) {
  const from = YMD.test(str(query.from)) ? str(query.from) : businessYmd(settings.startDate);
  const to = YMD.test(str(query.to)) ? str(query.to) : businessYmd(new Date());
  if (from > to) throw new ApiError(400, 'The start date is after the end date');
  return { from, to, start: startOfDay(from), end: endOfBusinessDay(to) };
}

// Day book: every voucher in a period, newest first, paged.
async function listVouchers(user, query = {}) {
  assert(canView(user), 'You cannot see the books');
  await syncBooks();
  const settings = await settingsDoc();
  const { from, to, start, end } = dateRange(query, settings);
  const filter = { date: { $gte: start, $lte: end } };
  if (TYPE_LABEL[query.type]) filter.type = query.type;
  if (query.status === 'cancelled') filter.status = 'cancelled';
  else if (query.status !== 'all') filter.status = 'posted';
  if (mongoose.isValidObjectId(query.account)) filter['lines.account'] = new mongoose.Types.ObjectId(String(query.account));
  const q = str(query.q);
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: rx }, { narration: rx }, { sourceRef: rx }];
  }
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  const page = Math.max(1, Number(query.page) || 1);
  const [total, docs, sums, names] = await Promise.all([
    Voucher.countDocuments(filter),
    Voucher.find(filter).sort({ date: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    Voucher.aggregate([{ $match: filter }, { $group: { _id: '$type', count: { $sum: 1 }, total: { $sum: '$total' } } }]),
    accountNames(),
  ]);
  return {
    from,
    to,
    items: docs.map((v) => presentVoucher(v, names)),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    byType: sums.map((s) => ({ type: s._id, label: TYPE_LABEL[s._id] || s._id, count: s.count, total: money(s.total) })),
  };
}

async function getVoucher(user, id) {
  assert(canView(user), 'You cannot see the books');
  const v = mongoose.isValidObjectId(id) ? await Voucher.findById(id).lean() : null;
  if (!v) throw new ApiError(404, 'Entry not found');
  return presentVoucher(v, await accountNames());
}

async function createVoucher(user, payload = {}) {
  assert(canPost(user), 'You cannot make entries in the books');
  const type = str(payload.type);
  if (!MANUAL_TYPES[type]) throw new ApiError(400, 'Choose journal, contra, payment or receipt');
  const settings = await settingsDoc();
  const day = parseDay(payload.date, 'Date');
  const date = new Date(`${day}T12:00:00+05:30`);
  if (date < settings.startDate) throw new ApiError(400, `The books start on ${businessYmd(settings.startDate)}; enter earlier figures as opening balances`);
  if (settings.lockDate && date <= settings.lockDate) throw new ApiError(400, `The books are locked up to ${businessYmd(settings.lockDate)}`);
  if (date > endOfBusinessDay(new Date())) throw new ApiError(400, 'The date cannot be in the future');

  const raw = Array.isArray(payload.lines) ? payload.lines : [];
  const lines = raw
    .map((l) => ({ account: str(l.account), debit: Math.max(0, money(l.debit)), credit: Math.max(0, money(l.credit)), note: str(l.note) }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  if (lines.length < 2) throw new ApiError(400, 'An entry needs at least two lines');
  if (lines.some((l) => l.debit > 0 && l.credit > 0)) throw new ApiError(400, 'Each line is either a debit or a credit');
  const dr = money(lines.reduce((s, l) => s + l.debit, 0));
  const cr = money(lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) > EPS) throw new ApiError(400, `Debits (${dr}) and credits (${cr}) must be equal`);
  const ids = [...new Set(lines.map((l) => l.account))];
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new ApiError(400, 'Choose an account on every line');
  const accounts = new Map((await BookAccount.find({ _id: { $in: ids } }).lean()).map((a) => [String(a._id), a]));
  for (const id of ids) {
    const a = accounts.get(id);
    if (!a) throw new ApiError(400, 'An account on this entry no longer exists');
    if (a.isActive === false) throw new ApiError(400, `${a.name} is inactive`);
    // Customer balances come from billing (invoices, payments, opening bills).
    if (a.customer) throw new ApiError(400, `${a.name} is a customer account; record their bills and payments on the customer's account page`);
    if (a.supplier) throw new ApiError(400, `${a.name} is a supplier account; record their bills, payments and debit notes under Purchases`);
    if (a.group === 'stock') throw new ApiError(400, `${a.name} is a stock account; enter the stock value as closing stock on the Statements page`);
  }
  const moneySide = (side) => lines.some((l) => l[side] > 0 && MONEY_GROUPS.includes(accounts.get(l.account).group));
  if (type === 'contra' && lines.some((l) => !MONEY_GROUPS.includes(accounts.get(l.account).group))) throw new ApiError(400, 'A contra entry only moves money between cash and bank accounts');
  if (type === 'payment' && !moneySide('credit')) throw new ApiError(400, 'A payment must be paid from a cash or bank account (credit it)');
  if (type === 'receipt' && !moneySide('debit')) throw new ApiError(400, 'A receipt must go into a cash or bank account (debit it)');

  const fy = fyOf(date);
  let number;
  for (;;) {
    number = `${MANUAL_TYPES[type]}/${fy}/${String(await nextSeq(`voucher:${type}:${fy}`)).padStart(4, '0')}`;
    if (!(await Voucher.exists({ type, number }))) break;
  }
  const doc = await Voucher.create({
    type,
    number,
    date,
    narration: str(payload.narration),
    lines,
    total: dr,
    createdBy: user._id,
    createdByName: user.fullName || user.username || '',
  });
  return presentVoucher(doc.toObject(), await accountNames());
}

async function cancelVoucher(user, id, reason) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can cancel entries');
  const v = mongoose.isValidObjectId(id) ? await Voucher.findById(id) : null;
  if (!v) throw new ApiError(404, 'Entry not found');
  if (v.auto) throw new ApiError(400, `This entry follows ${v.sourceRef || 'its document'}; cancel or void that instead`);
  if (v.status === 'cancelled') throw new ApiError(400, 'Already cancelled');
  const settings = await settingsDoc();
  if (settings.lockDate && v.date <= settings.lockDate) throw new ApiError(400, `The books are locked up to ${businessYmd(settings.lockDate)}`);
  const why = str(reason);
  if (why.length < 3) throw new ApiError(400, 'Give a reason for cancelling');
  v.status = 'cancelled';
  v.cancelledAt = new Date();
  v.cancelledByName = user.fullName || user.username || '';
  v.cancelReason = why;
  await v.save();
  return presentVoucher(v.toObject(), await accountNames());
}

// ---------------------------------------------------------------- ledger & trial balance

async function ledger(user, accountId, query = {}) {
  assert(canView(user), 'You cannot see the books');
  await syncBooks();
  const account = mongoose.isValidObjectId(accountId) ? await BookAccount.findById(accountId).lean() : null;
  if (!account) throw new ApiError(404, 'Account not found');
  const settings = await settingsDoc();
  const { from, to, start, end } = dateRange(query, settings);
  const id = account._id;
  const opening = (await openingByAccount([account])).get(String(id)) || 0;
  const before = (await movements({ before: start, account: id })).get(String(id)) || { debit: 0, credit: 0 };
  const openingAtFrom = money(opening + before.debit - before.credit);
  const [vouchers, names] = await Promise.all([Voucher.find({ status: 'posted', 'lines.account': id, date: { $gte: start, $lte: end } }).sort({ date: 1, _id: 1 }).lean(), accountNames()]);
  let running = openingAtFrom;
  const entries = vouchers.map((v) => {
    const mine = v.lines.filter((l) => String(l.account) === String(id));
    const debit = money(mine.reduce((s, l) => s + l.debit, 0));
    const credit = money(mine.reduce((s, l) => s + l.credit, 0));
    running = money(running + debit - credit);
    const others = v.lines.filter((l) => String(l.account) !== String(id)).map((l) => names.get(String(l.account)));
    return { id: String(v._id), date: v.date, type: v.type, typeLabel: TYPE_LABEL[v.type], number: v.number, narration: v.narration, against: [...new Set(others)].join(', '), debit, credit, balance: running, sourceLink: v.sourceLink || '' };
  });
  return {
    account: present(account),
    from,
    to,
    opening: openingAtFrom,
    debit: money(entries.reduce((s, e) => s + e.debit, 0)),
    credit: money(entries.reduce((s, e) => s + e.credit, 0)),
    closing: running,
    entries,
  };
}

// Every account's balance on a day, grouped; debits must equal credits.
async function trialBalance(user, query = {}) {
  assert(canView(user), 'You cannot see the books');
  await syncBooks();
  const settings = await settingsDoc();
  const asOf = YMD.test(str(query.asOf)) ? str(query.asOf) : businessYmd(new Date());
  const accounts = await BookAccount.find({}).lean();
  const [openings, moves] = await Promise.all([openingByAccount(accounts), movements({ to: endOfBusinessDay(asOf) })]);
  const rows = accounts
    .map((a) => {
      const m = moves.get(String(a._id)) || { debit: 0, credit: 0 };
      const opening = openings.get(String(a._id)) || 0;
      const balance = money(opening + m.debit - m.credit);
      return { ...present(a), opening, debitTotal: m.debit, creditTotal: m.credit, debit: balance > 0 ? balance : 0, credit: balance < 0 ? -balance : 0 };
    })
    .filter((r) => r.debit || r.credit || r.debitTotal || r.creditTotal || r.opening);
  const groups = GROUPS.map((g) => {
    const list = rows.filter((r) => r.group === g.id).sort((a, b) => a.name.localeCompare(b.name));
    return { id: g.id, label: g.label, nature: g.nature, debit: money(list.reduce((s, r) => s + r.debit, 0)), credit: money(list.reduce((s, r) => s + r.credit, 0)), accounts: list };
  }).filter((g) => g.accounts.length);
  const debit = money(rows.reduce((s, r) => s + r.debit, 0));
  const credit = money(rows.reduce((s, r) => s + r.credit, 0));
  // Vouchers always balance, so any difference comes from the opening balances.
  const openingDifference = money([...openings.values()].reduce((s, v) => s + v, 0));
  const early = await Voucher.countDocuments({ status: 'posted', date: { $lt: settings.startDate } });
  return { asOf, startDate: businessYmd(settings.startDate), groups, debit, credit, difference: money(debit - credit), openingDifference, entriesBeforeStart: early };
}

async function resync(user) {
  assert(isSuperAdmin(user) || canCorrect(user), 'Only Accounts managers and the owner can rebuild the books');
  return syncBooks({ full: true });
}

module.exports = {
  getSettings,
  saveSettings,
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  saveOpenings,
  listVouchers,
  getVoucher,
  createVoucher,
  cancelVoucher,
  ledger,
  trialBalance,
  resync,
  TYPE_LABEL,
  openingByAccount,
  movements,
};
