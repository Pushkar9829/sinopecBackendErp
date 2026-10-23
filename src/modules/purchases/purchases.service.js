const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { hasPermission, isSuperAdmin } = require('../../utils/permissions');
const { nextSeq } = require('../../utils/counter');
const { businessYmd, endOfBusinessDay } = require('../../utils/businessTime');
const Supplier = require('../supplier/supplier.model');
const InventoryItem = require('../inventory/item.model');
const companyService = require('../company/company.service');
const { BookAccount, BooksSettings } = require('../books/books.models');
const { ensureChart } = require('../books/books.post');
const { assertOpenPeriod: lockCheck, assertOpeningsOpen } = require('../books/books.lock');
const { PurchaseBill, SupplierPayment, DebitNote } = require('./purchase.models');

const DAY = 24 * 60 * 60 * 1000;
const EPS = 0.005;
const money = (n) => {
  const v = Number(n) || 0;
  return Math.round((v + Math.sign(v) * Number.EPSILON) * 100) / 100;
};
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const actor = (user) => user?.fullName || user?.username || '';
const METHODS = ['bank_transfer', 'upi', 'cheque', 'cash', 'other'];
const METHOD_LABEL = { bank_transfer: 'Bank transfer', upi: 'UPI', cheque: 'Cheque', cash: 'Cash', other: 'Other' };
// Accounts a bill line can be booked to.
// Stock is valued by closing stock on the Statements page, so bills go to Purchases instead.
const LINE_GROUPS = ['purchases', 'direct_expenses', 'indirect_expenses', 'fixed_assets'];

// ---------------------------------------------------------------- access

const canView = (user) => hasPermission(user, 'accounts:read');
const canCreate = (user) => hasPermission(user, 'accounts:create');
const canCorrect = (user) => isSuperAdmin(user) || hasPermission(user, 'accounts:update');
function assert(ok, message) {
  if (!ok) throw new ApiError(403, message);
}

// ---------------------------------------------------------------- helpers

function parseDay(value, label, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, `${label} is required`);
    return null;
  }
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00+05:30` : value);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, `${label} is not a valid date`);
  return date;
}
function notFuture(date, label) {
  if (date.getTime() > endOfBusinessDay(new Date()).getTime()) throw new ApiError(400, `${label} cannot be in the future`);
}
function fyOf(date) {
  const ymd = businessYmd(date);
  const year = Number(ymd.slice(0, 4));
  const start = Number(ymd.slice(5, 7)) >= 4 ? year : year - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}
async function nextNumber(prefix, date, Model, field = 'number') {
  const fy = fyOf(date);
  for (;;) {
    const number = `${prefix}/${fy}/${String(await nextSeq(`${prefix}:${fy}`)).padStart(4, '0')}`;
    if (!(await Model.exists({ [field]: number }))) return number;
  }
}
async function booksSettings() {
  await ensureChart();
  return BooksSettings.findOne({ key: 'default' }).lean();
}
// Entries before the books start or in a locked period cannot change.
async function assertOpenPeriod(date, what) {
  await lockCheck(date, what);
  return booksSettings();
}

async function loadSupplier(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Supplier not found');
  const s = await Supplier.findById(id).lean();
  if (!s) throw new ApiError(404, 'Supplier not found');
  return s;
}

// CGST+SGST inside the state, IGST across states (from the two GSTINs).
async function taxPlace(supplier) {
  const company = await companyService.getSettings();
  const supplierState = /^\d{2}/.test(supplier.gstNumber || '') ? supplier.gstNumber.slice(0, 2) : '';
  return { company, intraState: !supplierState || !company.stateCode || supplierState === company.stateCode };
}

async function lineAccounts(lines) {
  await ensureChart();
  const ids = [...new Set(lines.map((l) => str(l.account)).filter(Boolean))];
  if (ids.some((id) => !mongoose.isValidObjectId(id))) throw new ApiError(400, 'Choose an account on every line');
  const found = await BookAccount.find({ _id: { $in: ids } }).lean();
  const purchases = await BookAccount.findOne({ key: 'purchases' }).lean();
  const map = new Map(found.map((a) => [String(a._id), a]));
  for (const a of found) {
    if (!LINE_GROUPS.includes(a.group)) throw new ApiError(400, `${a.name} is not a purchase or expense account`);
    if (a.isActive === false) throw new ApiError(400, `${a.name} is inactive`);
  }
  return (id) => map.get(str(id)) || purchases;
}

// Prices the lines of a bill or debit note. A line is quantity × rate less
// discount, or just an amount (quantity left empty).
async function priceLines(raw, intraState, { forNote = false } = {}) {
  if (!Array.isArray(raw) || !raw.length) throw new ApiError(400, 'Add at least one line');
  const accountOf = await lineAccounts(raw);
  const lines = raw.map((l, index) => {
    const quantity = Math.max(0, money(l.quantity));
    const rate = Math.max(0, money(l.rate));
    const discount = Math.max(0, money(l.discount));
    const amount = Math.max(0, money(l.amount ?? l.taxable));
    const taxable = quantity > 0 ? money(quantity * rate - discount) : money(amount - discount);
    if (!(taxable > 0)) throw new ApiError(400, `Line ${index + 1} needs a quantity and rate, or an amount`);
    const gstPercent = Math.max(0, Number(l.gstPercent) || 0);
    if (gstPercent > 40) throw new ApiError(400, `Line ${index + 1}: GST % looks wrong`);
    const tax = (taxable * gstPercent) / 100;
    const cgst = intraState ? money(tax / 2) : 0;
    const sgst = intraState ? money(tax / 2) : 0;
    const igst = intraState ? 0 : money(tax);
    const account = accountOf(l.account);
    return {
      description: str(l.description) || account.name,
      account: account._id,
      accountName: account.name,
      hsnCode: str(l.hsnCode).toUpperCase().replace(/\s+/g, ''),
      quantity,
      unit: str(l.unit),
      rate,
      discount,
      taxable,
      gstPercent,
      cgst,
      sgst,
      igst,
      amount: money(taxable + cgst + sgst + igst),
      lot: !forNote && mongoose.isValidObjectId(l.lot) ? new mongoose.Types.ObjectId(String(l.lot)) : null,
    };
  });
  const sum = (k) => money(lines.reduce((s, l) => s + l[k], 0));
  return { lines, taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), gross: sum('amount') };
}

// An unregistered supplier cannot charge GST we can claim back: such lines
// are entered at 0% (any tax they charged is part of the cost).
function assertNoGstWithoutGstin(supplier, lines) {
  if (str(supplier.gstNumber)) return;
  const taxed = (Array.isArray(lines) ? lines : []).findIndex((l) => (Number(l?.gstPercent) || 0) > 0);
  if (taxed >= 0) {
    throw new ApiError(400, `${supplier.name} has no GSTIN, so GST on this bill cannot be claimed as input credit. Enter line ${taxed + 1} (and every line) at 0% GST, with any tax charged included in the amount, or add the supplier's GSTIN first`);
  }
}

// ---------------------------------------------------------------- bills

function presentBill(b) {
  return { ...b, id: String(b._id), supplier: String(b.supplier), _id: undefined, __v: undefined };
}

async function createBill(user, payload = {}) {
  assert(canCreate(user), 'You cannot enter supplier bills');
  const supplier = await loadSupplier(payload.supplierId);
  const billDate = parseDay(payload.billDate, 'Bill date');
  notFuture(billDate, 'The bill date');
  const settings = await assertOpenPeriod(billDate, 'a bill dated then');
  if (billDate < settings.startDate) throw new ApiError(400, `The books start on ${businessYmd(settings.startDate)}; enter older unpaid bills as opening bills`);
  const supplierBillNo = str(payload.supplierBillNo);
  if (!supplierBillNo) throw new ApiError(400, "Enter the supplier's bill number");
  if (await PurchaseBill.exists({ supplier: supplier._id, supplierBillNo, status: 'issued' })) throw new ApiError(409, `Bill ${supplierBillNo} from ${supplier.name} is already entered`);
  assertNoGstWithoutGstin(supplier, payload.lines);
  const { company, intraState } = await taxPlace(supplier);
  const priced = await priceLines(payload.lines, intraState);
  // The bill's own total may round differently; accept up to ₹5 of difference.
  let roundOff = money(Math.round(priced.gross) - priced.gross);
  if (payload.billTotal !== undefined && payload.billTotal !== '' && payload.billTotal !== null) {
    roundOff = money(Number(payload.billTotal) - priced.gross);
    if (Math.abs(roundOff) > 5) throw new ApiError(400, `The bill total differs from the lines by ₹${Math.abs(roundOff)}; check the lines`);
  }
  const creditDays = payload.creditDays !== undefined && payload.creditDays !== '' ? Math.max(0, Number(payload.creditDays) || 0) : supplier.creditDays ?? company.defaultCreditDays ?? 30;
  const doc = await PurchaseBill.create({
    kind: 'purchase',
    number: await nextNumber('PB', billDate, PurchaseBill),
    supplier: supplier._id,
    supplierName: supplier.name,
    supplierGstin: supplier.gstNumber || '',
    supplierBillNo,
    billDate,
    creditDays,
    dueDate: endOfBusinessDay(new Date(billDate.getTime() + creditDays * DAY)),
    intraState,
    lines: priced.lines,
    taxable: priced.taxable,
    cgst: priced.cgst,
    sgst: priced.sgst,
    igst: priced.igst,
    roundOff,
    total: money(priced.gross + roundOff),
    notes: str(payload.notes),
    createdBy: user._id,
    createdByName: actor(user),
  });
  // A raw material lot without a price takes the bill's rate (for stock value).
  for (const line of priced.lines.filter((l) => l.lot && l.rate > 0)) {
    await InventoryItem.updateOne({ _id: line.lot, category: 'raw', $or: [{ unitPrice: null }, { unitPrice: { $exists: false } }] }, { $set: { unitPrice: line.rate } });
  }
  return presentBill(doc.toObject());
}

async function addOpeningBill(user, supplierId, payload = {}) {
  assert(canCreate(user), 'You cannot enter supplier bills');
  await assertOpeningsOpen('opening bills');
  const supplier = await loadSupplier(supplierId);
  const number = str(payload.number);
  if (!number) throw new ApiError(400, "Enter the supplier's bill number");
  const billDate = parseDay(payload.date, 'Bill date');
  const total = money(payload.amount);
  if (!(total > 0)) throw new ApiError(400, 'Amount must be more than 0');
  const dueDate = parseDay(payload.dueDate, 'Due date', { required: false }) || billDate;
  if (await PurchaseBill.exists({ supplier: supplier._id, supplierBillNo: number, status: 'issued' })) throw new ApiError(409, `Bill ${number} from ${supplier.name} is already entered`);
  const doc = await PurchaseBill.create({
    kind: 'opening',
    number: await nextNumber('POB', billDate, PurchaseBill),
    supplier: supplier._id,
    supplierName: supplier.name,
    supplierGstin: supplier.gstNumber || '',
    supplierBillNo: number,
    billDate,
    dueDate: endOfBusinessDay(dueDate),
    total,
    taxable: total,
    notes: str(payload.notes) || 'Opening balance',
    createdBy: user._id,
    createdByName: actor(user),
  });
  return presentBill(doc.toObject());
}

async function cancelBill(user, id, reason) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can cancel bills');
  const bill = mongoose.isValidObjectId(id) ? await PurchaseBill.findById(id) : null;
  if (!bill) throw new ApiError(404, 'Bill not found');
  if (bill.status === 'cancelled') throw new ApiError(400, 'Already cancelled');
  if (bill.kind === 'opening') await assertOpeningsOpen('opening bills');
  await assertOpenPeriod(bill.billDate, 'this bill');
  const why = str(reason);
  if (why.length < 3) throw new ApiError(400, 'Give a reason for cancelling the bill');
  // As with sale invoices: what was made against the bill goes first.
  const label = bill.supplierBillNo || bill.number;
  if (await DebitNote.exists({ bill: bill._id, status: 'issued' })) throw new ApiError(400, `Debit notes are made against bill ${label}; cancel them first`);
  if (await SupplierPayment.exists({ bill: bill._id, voidedAt: null })) throw new ApiError(400, `Payments are recorded against bill ${label}; void them first`);
  bill.status = 'cancelled';
  bill.cancelledAt = new Date();
  bill.cancelledByName = actor(user);
  bill.cancelReason = why;
  await bill.save();
  return presentBill(bill.toObject());
}

async function getBill(user, id) {
  assert(canView(user), 'You cannot see purchases');
  const bill = mongoose.isValidObjectId(id) ? await PurchaseBill.findById(id).lean() : null;
  if (!bill) throw new ApiError(404, 'Bill not found');
  const account = await supplierAccount(bill.supplier);
  const row = account.bills.find((b) => b.id === String(bill._id));
  return { ...presentBill(bill), paid: row?.paid || 0, balance: row?.balance ?? 0, payState: row?.payState || '' };
}

function dayRange(query) {
  const range = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(query.from))) range.$gte = new Date(`${query.from}T00:00:00+05:30`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(query.to))) range.$lte = endOfBusinessDay(str(query.to));
  return Object.keys(range).length ? range : null;
}
const pageOf = (query) => ({ page: Math.max(1, Number(query.page) || 1), pageSize: Math.min(100, Math.max(1, Number(query.pageSize) || 25)) });

async function listBills(user, query = {}) {
  assert(canView(user), 'You cannot see purchases');
  const filter = {};
  if (mongoose.isValidObjectId(query.supplier)) filter.supplier = new mongoose.Types.ObjectId(String(query.supplier));
  if (['purchase', 'opening'].includes(query.kind)) filter.kind = query.kind;
  if (query.status === 'cancelled') filter.status = 'cancelled';
  else if (query.status !== 'all') filter.status = 'issued';
  const range = dayRange(query);
  if (range) filter.billDate = range;
  const q = str(query.q);
  if (q) {
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: rx }, { supplierBillNo: rx }, { supplierName: rx }];
  }
  const { page, pageSize } = pageOf(query);
  const [total, docs, sums] = await Promise.all([
    PurchaseBill.countDocuments(filter),
    PurchaseBill.find(filter).sort({ billDate: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    PurchaseBill.aggregate([{ $match: filter }, { $group: { _id: null, taxable: { $sum: '$taxable' }, cgst: { $sum: '$cgst' }, sgst: { $sum: '$sgst' }, igst: { $sum: '$igst' }, total: { $sum: '$total' } } }]),
  ]);
  return { items: docs.map(presentBill), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), sums: sums[0] ? { taxable: money(sums[0].taxable), cgst: money(sums[0].cgst), sgst: money(sums[0].sgst), igst: money(sums[0].igst), total: money(sums[0].total) } : null };
}

// ---------------------------------------------------------------- payments

async function payFromAccount(fromAccount, method) {
  await ensureChart();
  if (mongoose.isValidObjectId(fromAccount)) {
    const a = await BookAccount.findById(fromAccount).lean();
    if (!a || !['bank', 'cash'].includes(a.group)) throw new ApiError(400, 'Pay from a cash or bank account');
    return a._id;
  }
  if (method === 'cash') return (await BookAccount.findOne({ key: 'cash' }).lean())._id;
  const s = await booksSettings();
  return s.defaultBank || (await BookAccount.findOne({ key: 'bank' }).lean())._id;
}

async function createPayment(user, supplierId, payload = {}) {
  assert(canCreate(user), 'You cannot record supplier payments');
  const supplier = await loadSupplier(supplierId);
  const amount = money(payload.amount);
  if (!(amount > 0)) throw new ApiError(400, 'Amount must be more than 0');
  const tds = money(payload.tds);
  if (tds < 0) throw new ApiError(400, 'TDS cannot be negative');
  if (tds > amount) throw new ApiError(400, 'TDS looks too high: it is a small part of the bill (usually 0.1%–10%)');
  const paidAt = parseDay(payload.paidAt || new Date(), 'Payment date');
  notFuture(paidAt, 'The payment date');
  await assertOpenPeriod(paidAt, 'a payment dated then');
  const method = METHODS.includes(payload.method) ? payload.method : 'bank_transfer';
  let bill = null;
  if (payload.billId) {
    bill = mongoose.isValidObjectId(payload.billId) ? await PurchaseBill.findOne({ _id: payload.billId, supplier: supplier._id, status: 'issued' }).lean() : null;
    if (!bill) throw new ApiError(400, 'That bill is not an open bill of this supplier');
  }
  const doc = await SupplierPayment.create({
    number: await nextNumber('SP-PAY', paidAt, SupplierPayment),
    supplier: supplier._id,
    bill: bill?._id || null,
    paidAt,
    amount,
    tds,
    tdsSection: tds ? str(payload.tdsSection).toUpperCase().slice(0, 20) : '',
    method,
    fromAccount: await payFromAccount(payload.fromAccount, method),
    reference: str(payload.reference),
    note: str(payload.note),
    createdBy: user._id,
    createdByName: actor(user),
  });
  return { ...doc.toJSON(), id: String(doc._id) };
}

async function voidPayment(user, id, reason) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can void payments');
  const p = mongoose.isValidObjectId(id) ? await SupplierPayment.findById(id) : null;
  if (!p) throw new ApiError(404, 'Payment not found');
  if (p.voidedAt) throw new ApiError(400, 'Already voided');
  await assertOpenPeriod(p.paidAt, 'this payment');
  const why = str(reason);
  if (why.length < 3) throw new ApiError(400, 'Give a reason for voiding the payment');
  p.voidedAt = new Date();
  p.voidedByName = actor(user);
  p.voidReason = why;
  await p.save();
  return { ...p.toJSON(), id: String(p._id) };
}

// ---------------------------------------------------------------- debit notes

async function createDebitNote(user, supplierId, payload = {}) {
  assert(canCreate(user), 'You cannot make debit notes');
  const supplier = await loadSupplier(supplierId);
  const date = parseDay(payload.date || new Date(), 'Date');
  notFuture(date, 'The date');
  await assertOpenPeriod(date, 'a debit note dated then');
  const reason = str(payload.reason);
  if (reason.length < 3) throw new ApiError(400, 'Give the reason (goods returned, rate difference…)');
  let bill = null;
  if (payload.billId) {
    bill = mongoose.isValidObjectId(payload.billId) ? await PurchaseBill.findOne({ _id: payload.billId, supplier: supplier._id, status: 'issued' }).lean() : null;
    if (!bill) throw new ApiError(400, 'That bill is not an open bill of this supplier');
  }
  // A note against a bill that carried GST reverses that GST; otherwise the
  // supplier needs a GSTIN for the note to carry any.
  if (!bill || !(bill.cgst || bill.sgst || bill.igst)) assertNoGstWithoutGstin(supplier, payload.lines);
  const intraState = bill ? bill.intraState : (await taxPlace(supplier)).intraState;
  const priced = await priceLines(payload.lines, intraState, { forNote: true });
  const total = money(Math.round(priced.gross * 100) / 100);
  if (bill) {
    // Earlier debit notes on the same bill count towards the limit.
    const earlier = await DebitNote.aggregate([{ $match: { bill: bill._id, status: 'issued' } }, { $group: { _id: null, total: { $sum: '$total' } } }]);
    const already = money(earlier[0]?.total || 0);
    if (total + already > (bill.total || 0) + EPS) {
      throw new ApiError(400, `Debit notes on bill ${bill.supplierBillNo || bill.number} would come to ₹${money(total + already)}, more than the bill (₹${bill.total})${already ? `; ₹${already} is already noted` : ''}`);
    }
  }
  const doc = await DebitNote.create({
    number: await nextNumber('DN', date, DebitNote),
    supplier: supplier._id,
    bill: bill?._id || null,
    date,
    intraState,
    lines: priced.lines,
    taxable: priced.taxable,
    cgst: priced.cgst,
    sgst: priced.sgst,
    igst: priced.igst,
    total,
    reason,
    createdBy: user._id,
    createdByName: actor(user),
  });
  return { ...doc.toJSON(), id: String(doc._id) };
}

async function cancelDebitNote(user, id, reason) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can cancel debit notes');
  const note = mongoose.isValidObjectId(id) ? await DebitNote.findById(id) : null;
  if (!note) throw new ApiError(404, 'Debit note not found');
  if (note.status === 'cancelled') throw new ApiError(400, 'Already cancelled');
  await assertOpenPeriod(note.date, 'this debit note');
  const why = str(reason);
  if (why.length < 3) throw new ApiError(400, 'Give a reason for cancelling');
  note.status = 'cancelled';
  note.cancelledAt = new Date();
  note.cancelReason = why;
  await note.save();
  return { ...note.toJSON(), id: String(note._id) };
}

// ---------------------------------------------------------------- the supplier's account

// What the plant owes one supplier, matched the same way every time: a
// payment or debit note made for one bill goes to that bill; everything else
// pays the bills that fell due first.
async function supplierAccount(supplierId, { asOf = new Date() } = {}) {
  const id = new mongoose.Types.ObjectId(String(supplierId));
  const docs = await supplierDocs({ supplier: id });
  return supplierAccountFrom(docs.get(String(id)), { asOf });
}

// Bills, payments and debit notes read once for many suppliers, grouped by supplier.
async function supplierDocs(match = {}) {
  const [bills, payments, notes] = await Promise.all([
    PurchaseBill.find({ ...match, status: 'issued' }).select('-lines').sort({ dueDate: 1, billDate: 1, _id: 1 }).lean(),
    SupplierPayment.find({ ...match, voidedAt: null }).sort({ paidAt: 1, _id: 1 }).lean(),
    DebitNote.find({ ...match, status: 'issued' }).select('-lines').sort({ date: 1, _id: 1 }).lean(),
  ]);
  const bySupplier = new Map();
  const bucket = (sid) => {
    const key = String(sid);
    if (!bySupplier.has(key)) bySupplier.set(key, { bills: [], payments: [], notes: [] });
    return bySupplier.get(key);
  };
  for (const row of bills) bucket(row.supplier).bills.push(row);
  for (const row of payments) bucket(row.supplier).payments.push(row);
  for (const row of notes) bucket(row.supplier).notes.push(row);
  return bySupplier;
}

// The account worked out from already-loaded documents.
function supplierAccountFrom({ bills = [], payments = [], notes = [] } = {}, { asOf = new Date() } = {}) {
  const state = bills.map((b) => ({ ...b, paid: 0 }));
  const balanceOf = (row) => money(row.total - row.paid);
  const apply = (rows, amount) => {
    let left = amount;
    for (const row of rows) {
      if (left <= EPS) break;
      const take = Math.min(left, balanceOf(row));
      if (take > 0) {
        row.paid = money(row.paid + take);
        left = money(left - take);
      }
    }
    return left;
  };
  let pool = 0;
  const credits = [];
  for (const n of notes) {
    credits.push({ date: n.date, type: 'debit_note', ref: n.number, detail: n.reason, amount: n.total, id: String(n._id) });
    pool = money(pool + apply(n.bill ? state.filter((r) => String(r._id) === String(n.bill)) : [], n.total));
  }
  for (const p of payments) {
    // TDS we deducted settles the bill along with the money paid.
    const settles = money(p.amount + (p.tds || 0));
    const detail = [METHOD_LABEL[p.method] || p.method, p.reference, p.tds ? `TDS ₹${p.tds}${p.tdsSection ? ` (${p.tdsSection})` : ''} deducted` : ''].filter(Boolean).join(' · ');
    credits.push({ date: p.paidAt, type: 'payment', ref: p.number, detail, amount: settles, id: String(p._id) });
    pool = money(pool + apply(p.bill ? state.filter((r) => String(r._id) === String(p.bill)) : [], settles));
  }
  const advance = apply(state, pool);
  const now = asOf.getTime();
  const rows = state.map((r) => {
    const balance = balanceOf(r);
    const overdueDays = balance > EPS && new Date(r.dueDate).getTime() < now ? Math.floor((now - new Date(r.dueDate).getTime()) / DAY) : 0;
    return {
      id: String(r._id),
      kind: r.kind,
      number: r.number,
      supplierBillNo: r.supplierBillNo,
      billDate: r.billDate,
      dueDate: r.dueDate,
      total: r.total,
      paid: r.paid,
      balance,
      overdueDays,
      dueInDays: balance > EPS && overdueDays === 0 ? Math.floor((new Date(r.dueDate).getTime() - now) / DAY) : null,
      payState: balance <= EPS ? 'paid' : r.paid > EPS ? 'partly_paid' : 'unpaid',
    };
  });
  const open = rows.filter((r) => r.balance > EPS);
  const ageing = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  for (const r of open) {
    const bucket = r.overdueDays === 0 ? 'current' : r.overdueDays <= 30 ? 'd1_30' : r.overdueDays <= 60 ? 'd31_60' : r.overdueDays <= 90 ? 'd61_90' : 'd90plus';
    ageing[bucket] = money(ageing[bucket] + r.balance);
  }
  const sum = (list, k) => money(list.reduce((s, r) => s + r[k], 0));
  return {
    bills: rows,
    credits: credits.sort((a, b) => new Date(a.date) - new Date(b.date)),
    summary: {
      billed: sum(rows, 'total'),
      paid: money(credits.reduce((s, c) => s + c.amount, 0)),
      outstanding: sum(open, 'balance'),
      overdue: money(open.filter((r) => r.overdueDays > 0).reduce((s, r) => s + r.balance, 0)),
      dueThisWeek: money(open.filter((r) => r.dueInDays !== null && r.dueInDays <= 7).reduce((s, r) => s + r.balance, 0)),
      advance,
      oldestOverdueDays: open.reduce((m, r) => Math.max(m, r.overdueDays), 0),
      ageing,
    },
  };
}

async function supplierLedger(user, supplierId) {
  assert(canView(user), 'You cannot see purchases');
  const supplier = await loadSupplier(supplierId);
  const account = await supplierAccount(supplier._id);
  // From the plant's side: a bill raises what we owe (credit), payments and
  // debit notes lower it (debit). Balance shown as "owed" when positive.
  const entries = [
    ...account.bills.map((b) => ({ date: b.billDate, type: b.kind === 'opening' ? 'opening' : 'bill', ref: b.supplierBillNo || b.number, detail: b.kind === 'opening' ? 'Opening balance' : `Our ref ${b.number}`, debit: 0, credit: b.total, id: b.id })),
    ...account.credits.map((c) => ({ date: c.date, type: c.type, ref: c.ref, detail: c.detail, debit: c.amount, credit: 0, id: c.id })),
  ].sort((a, b) => new Date(a.date) - new Date(b.date) || a.debit - b.debit);
  let running = 0;
  for (const e of entries) {
    running = money(running + e.credit - e.debit);
    e.balance = running;
  }
  const [payments, notes] = await Promise.all([
    SupplierPayment.find({ supplier: supplier._id }).sort({ paidAt: -1 }).limit(300).lean(),
    DebitNote.find({ supplier: supplier._id }).sort({ date: -1 }).limit(300).lean(),
  ]);
  return {
    supplier: { id: String(supplier._id), code: supplier.code, name: supplier.name, gstNumber: supplier.gstNumber || '', creditDays: supplier.creditDays, mobile: supplier.mobile || '' },
    summary: account.summary,
    bills: account.bills,
    entries,
    payments: payments.map((p) => ({ ...p, id: String(p._id), methodLabel: METHOD_LABEL[p.method] || p.method })),
    debitNotes: notes.map((n) => ({ ...n, id: String(n._id) })),
  };
}

// Every supplier with something owed (or paid ahead), most overdue first.
async function payables(user) {
  assert(canView(user), 'You cannot see purchases');
  const ids = new Set([...(await PurchaseBill.distinct('supplier', { status: 'issued' })).map(String), ...(await SupplierPayment.distinct('supplier', { voidedAt: null })).map(String)]);
  const suppliers = await Supplier.find({ _id: { $in: [...ids] } }).select('code name mobile creditDays').lean();
  const docs = await supplierDocs({ supplier: { $in: suppliers.map((s) => s._id) } });
  const now = new Date();
  const rows = [];
  for (const s of suppliers) {
    const account = supplierAccountFrom(docs.get(String(s._id)), { asOf: now });
    rows.push({
      id: String(s._id),
      code: s.code,
      name: s.name,
      mobile: s.mobile || '',
      creditDays: s.creditDays,
      ...account.summary,
      openBills: account.bills.filter((b) => b.balance > EPS).length,
      lastPaymentAt: account.credits.filter((c) => c.type === 'payment').at(-1)?.date || null,
    });
  }
  rows.sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding);
  const total = (k) => money(rows.reduce((s, r) => s + (r[k] || 0), 0));
  const ageing = {};
  for (const k of ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus']) ageing[k] = money(rows.reduce((s, r) => s + r.ageing[k], 0));
  return { rows, totals: { outstanding: total('outstanding'), overdue: total('overdue'), dueThisWeek: total('dueThisWeek'), advance: total('advance'), ageing } };
}

async function listPayments(user, query = {}) {
  assert(canView(user), 'You cannot see purchases');
  const filter = {};
  if (mongoose.isValidObjectId(query.supplier)) filter.supplier = new mongoose.Types.ObjectId(String(query.supplier));
  if (query.status !== 'all') filter.voidedAt = query.status === 'voided' ? { $ne: null } : null;
  const range = dayRange(query);
  if (range) filter.paidAt = range;
  const { page, pageSize } = pageOf(query);
  const [total, docs] = await Promise.all([SupplierPayment.countDocuments(filter), SupplierPayment.find(filter).sort({ paidAt: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).populate('supplier', 'code name').lean()]);
  return {
    items: docs.map((p) => ({ ...p, id: String(p._id), supplierId: String(p.supplier?._id || p.supplier), supplierName: p.supplier?.name || '', methodLabel: METHOD_LABEL[p.method] || p.method })),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

async function listDebitNotes(user, query = {}) {
  assert(canView(user), 'You cannot see purchases');
  const filter = {};
  if (mongoose.isValidObjectId(query.supplier)) filter.supplier = new mongoose.Types.ObjectId(String(query.supplier));
  if (query.status !== 'all') filter.status = query.status === 'cancelled' ? 'cancelled' : 'issued';
  const range = dayRange(query);
  if (range) filter.date = range;
  const { page, pageSize } = pageOf(query);
  const [total, docs] = await Promise.all([DebitNote.countDocuments(filter), DebitNote.find(filter).sort({ date: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).populate('supplier', 'code name').lean()]);
  return { items: docs.map((n) => ({ ...n, id: String(n._id), supplierId: String(n.supplier?._id || n.supplier), supplierName: n.supplier?.name || '' })), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

// Accounts a bill line can use, and the cash/bank accounts to pay from.
async function formOptions(user) {
  assert(canView(user), 'You cannot see purchases');
  await ensureChart();
  const accounts = await BookAccount.find({ isActive: { $ne: false }, group: { $in: [...LINE_GROUPS, 'bank', 'cash'] } }).sort({ group: 1, name: 1 }).lean();
  const settings = await booksSettings();
  return {
    lineAccounts: accounts.filter((a) => LINE_GROUPS.includes(a.group)).map((a) => ({ id: String(a._id), name: a.name, group: a.group, key: a.key || null })),
    moneyAccounts: accounts.filter((a) => ['bank', 'cash'].includes(a.group)).map((a) => ({ id: String(a._id), name: a.name, group: a.group })),
    defaultBank: settings.defaultBank ? String(settings.defaultBank) : null,
  };
}

// Raw material lots of this supplier, to link on a bill line.
async function supplierLots(user, supplierId) {
  assert(canView(user), 'You cannot see purchases');
  const lots = await InventoryItem.find({ supplier: supplierId, category: 'raw', isActive: { $ne: false } }).sort({ createdAt: -1 }).limit(100).lean();
  return lots.map((l) => ({ id: String(l._id), name: l.name, quantity: l.quantity, unit: l.unit, unitPrice: l.unitPrice, addedAt: l.createdAt }));
}

module.exports = {
  createBill,
  addOpeningBill,
  cancelBill,
  getBill,
  listBills,
  createPayment,
  voidPayment,
  listPayments,
  createDebitNote,
  cancelDebitNote,
  listDebitNotes,
  supplierAccount,
  supplierLedger,
  payables,
  formOptions,
  supplierLots,
};
