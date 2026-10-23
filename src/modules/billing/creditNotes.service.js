const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { nextSeq } = require('../../utils/counter');
const { businessYmd, endOfBusinessDay } = require('../../utils/businessTime');
const { hasPermission, isSuperAdmin } = require('../../utils/permissions');
const Customer = require('../customer/customer.model');
const companyService = require('../company/company.service');
const { assertOpenPeriod, assertAfterStart } = require('../books/books.lock');
const Invoice = require('./invoice.model');
const CreditNote = require('./creditNote.model');
const billing = require('./billing.service');

// Credit notes (returns, rate differences) and bad-debt write-offs: both
// lower what a customer owes; billing.customerAccount applies them.

const EPS = 0.005;
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const actor = (user) => user?.fullName || user?.username || '';
const KIND = { credit_note: 'Credit note', write_off: 'Write-off' };

const canView = (user) => isSuperAdmin(user) || hasPermission(user, 'accounts:read') || hasPermission(user, 'sales:read');
const canCreate = (user) => isSuperAdmin(user) || hasPermission(user, 'accounts:create');
const canCorrect = (user) => isSuperAdmin(user) || hasPermission(user, 'accounts:update');
function assert(ok, message) {
  if (!ok) throw new ApiError(403, message);
}

function parseDay(value, label) {
  const text = value instanceof Date ? businessYmd(value) : str(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new ApiError(400, `${label} is not a valid date`);
  const date = new Date(`${text}T12:00:00+05:30`);
  if (date.getTime() > endOfBusinessDay(new Date()).getTime()) throw new ApiError(400, `${label} cannot be in the future`);
  return date;
}

async function nextNumber(prefix, date) {
  const fy = billing.financialYear(date);
  for (;;) {
    const number = `${prefix}/${fy}/${String(await nextSeq(`${prefix}:${fy}`)).padStart(4, '0')}`;
    if (!(await CreditNote.exists({ number }))) return number;
  }
}

async function loadCustomer(id) {
  const customer = mongoose.isValidObjectId(id) ? await Customer.findById(id).lean() : null;
  if (!customer) throw new ApiError(404, 'Customer not found');
  return customer;
}

async function openInvoice(customerId, invoiceId) {
  if (!invoiceId) return null;
  const invoice = mongoose.isValidObjectId(invoiceId) ? await Invoice.findOne({ _id: invoiceId, customer: customerId, status: 'issued' }).lean() : null;
  if (!invoice) throw new ApiError(400, 'That bill is not an issued bill of this customer');
  return invoice;
}

function present(n) {
  return { ...n, id: String(n._id), _id: undefined, __v: undefined, customer: String(n.customer), invoice: n.invoice ? String(n.invoice) : null, kindLabel: KIND[n.kind] };
}

// lines: [{ description, hsnCode, quantity, unit, amount (before GST), gstPercent }]
function priceLines(raw, intraState) {
  if (!Array.isArray(raw) || !raw.length) throw new ApiError(400, 'Add at least one line');
  const lines = raw.map((l, index) => {
    const taxable = money(l.amount ?? l.taxable);
    if (!(taxable > 0)) throw new ApiError(400, `Line ${index + 1} needs an amount`);
    const gstPercent = Math.max(0, Number(l.gstPercent) || 0);
    if (gstPercent > 40) throw new ApiError(400, `Line ${index + 1}: GST % looks wrong`);
    const tax = (taxable * gstPercent) / 100;
    const cgst = intraState ? money(tax / 2) : 0;
    const sgst = intraState ? money(tax / 2) : 0;
    const igst = intraState ? 0 : money(tax);
    return {
      description: str(l.description) || 'Credit',
      hsnCode: str(l.hsnCode).toUpperCase().replace(/\s+/g, ''),
      quantity: Math.max(0, money(l.quantity)),
      unit: str(l.unit),
      taxable,
      gstPercent,
      cgst,
      sgst,
      igst,
      amount: money(taxable + cgst + sgst + igst),
    };
  });
  const sum = (k) => money(lines.reduce((s, l) => s + l[k], 0));
  return { lines, taxable: sum('taxable'), cgst: sum('cgst'), sgst: sum('sgst'), igst: sum('igst'), gross: sum('amount') };
}

// Goods returned, a rate difference or a discount after the sale: sales and
// output GST come down, and so does what the customer owes.
async function createCreditNote(user, customerId, payload = {}) {
  assert(canCreate(user), 'You cannot make credit notes');
  const customer = await loadCustomer(customerId);
  const date = parseDay(payload.date || new Date(), 'Date');
  await assertOpenPeriod(date, 'a credit note dated then');
  await assertAfterStart(date, 'a credit note');
  const reason = str(payload.reason);
  if (reason.length < 3) throw new ApiError(400, 'Give the reason (goods returned, rate difference…)');
  const invoice = await openInvoice(customer._id, payload.invoiceId);
  const company = await companyService.getSettings();
  const buyer = invoice?.buyer?.name || invoice?.buyer?.companyName ? invoice.buyer : billing.buyerOf(customer, null);
  const intraState = invoice ? invoice.intraState !== false : !buyer.stateCode || !company.stateCode || buyer.stateCode === company.stateCode;
  const priced = priceLines(payload.lines, intraState);
  const total = Math.round(priced.gross);
  const roundOff = money(total - priced.gross);
  if (invoice) {
    const earlier = await CreditNote.aggregate([{ $match: { invoice: invoice._id, status: 'issued', kind: 'credit_note' } }, { $group: { _id: null, total: { $sum: '$total' } } }]);
    const already = money(earlier[0]?.total || 0);
    if (total + already > invoice.total + EPS) throw new ApiError(400, `Credit notes on ${invoice.number} would come to ₹${money(total + already)}, more than the bill (₹${invoice.total})${already ? `; ₹${already} is already credited` : ''}`);
  }
  const doc = await CreditNote.create({
    kind: 'credit_note',
    number: await nextNumber('CN', date),
    customer: customer._id,
    invoice: invoice?._id || null,
    invoiceNumber: invoice?.number || '',
    invoiceDate: invoice?.invoiceDate || null,
    date,
    buyer,
    seller: company,
    intraState,
    ...priced,
    roundOff,
    total,
    reason,
    createdBy: user._id,
    createdByName: actor(user),
  });
  return present(doc.toObject());
}

// A debt that will not be paid: cleared to Bad debts (no GST effect).
async function writeOff(user, customerId, payload = {}) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can write off a debt');
  const customer = await loadCustomer(customerId);
  const date = parseDay(payload.date || new Date(), 'Date');
  await assertOpenPeriod(date, 'a write-off dated then');
  await assertAfterStart(date, 'a write-off');
  const reason = str(payload.reason);
  if (reason.length < 3) throw new ApiError(400, 'Give the reason for writing it off');
  const amount = money(payload.amount);
  if (!(amount > 0)) throw new ApiError(400, 'Amount must be more than 0');
  const invoice = await openInvoice(customer._id, payload.invoiceId);
  const account = await billing.customerAccount(customer._id);
  const limit = invoice ? account.invoices.find((i) => i.id === String(invoice._id))?.balance || 0 : account.summary.outstanding;
  if (amount > limit + EPS) throw new ApiError(400, `Only ₹${limit} is outstanding${invoice ? ` on ${invoice.number}` : ''}`);
  const doc = await CreditNote.create({
    kind: 'write_off',
    number: await nextNumber('WO', date),
    customer: customer._id,
    invoice: invoice?._id || null,
    invoiceNumber: invoice?.number || '',
    invoiceDate: invoice?.invoiceDate || null,
    date,
    buyer: billing.buyerOf(customer, null),
    total: amount,
    reason,
    createdBy: user._id,
    createdByName: actor(user),
  });
  return present(doc.toObject());
}

async function cancelNote(user, id, reason) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can cancel credit notes and write-offs');
  const note = mongoose.isValidObjectId(id) ? await CreditNote.findById(id) : null;
  if (!note) throw new ApiError(404, 'Not found');
  if (note.status === 'cancelled') throw new ApiError(400, 'Already cancelled');
  await assertOpenPeriod(note.date, `this ${KIND[note.kind].toLowerCase()}`);
  const why = str(reason);
  if (why.length < 3) throw new ApiError(400, 'Give a reason for cancelling');
  note.status = 'cancelled';
  note.cancelledAt = new Date();
  note.cancelledByName = actor(user);
  note.cancelReason = why;
  await note.save();
  return present(note.toObject());
}

async function getNote(user, id) {
  assert(canView(user), 'You cannot see credit notes');
  const note = mongoose.isValidObjectId(id) ? await CreditNote.findById(id).lean() : null;
  if (!note) throw new ApiError(404, 'Not found');
  return present(note);
}

// Register of credit notes and write-offs, paged, with totals.
async function listNotes(user, query = {}) {
  assert(canView(user), 'You cannot see credit notes');
  const filter = {};
  if (KIND[query.kind]) filter.kind = query.kind;
  filter.status = query.status === 'cancelled' ? 'cancelled' : query.status === 'all' ? { $in: ['issued', 'cancelled'] } : 'issued';
  if (mongoose.isValidObjectId(query.customer)) filter.customer = new mongoose.Types.ObjectId(String(query.customer));
  const range = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(query.from))) range.$gte = new Date(`${query.from}T00:00:00+05:30`);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str(query.to))) range.$lte = endOfBusinessDay(str(query.to));
  if (Object.keys(range).length) filter.date = range;
  if (str(query.q)) {
    const rx = new RegExp(str(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ number: rx }, { invoiceNumber: rx }, { 'buyer.name': rx }, { 'buyer.companyName': rx }, { reason: rx }];
  }
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));
  const page = Math.max(1, Number(query.page) || 1);
  const [total, docs, sums] = await Promise.all([
    CreditNote.countDocuments(filter),
    CreditNote.find(filter).select('-lines -seller').sort({ date: -1, _id: -1 }).skip((page - 1) * pageSize).limit(pageSize).lean(),
    CreditNote.aggregate([{ $match: filter }, { $group: { _id: null, taxable: { $sum: '$taxable' }, cgst: { $sum: '$cgst' }, sgst: { $sum: '$sgst' }, igst: { $sum: '$igst' }, total: { $sum: '$total' } } }]),
  ]);
  const s = sums[0] || {};
  return {
    items: docs.map((d) => ({ ...present(d), customerName: d.buyer?.companyName || d.buyer?.name || '' })),
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    sums: { taxable: money(s.taxable), cgst: money(s.cgst), sgst: money(s.sgst), igst: money(s.igst), total: money(s.total) },
  };
}

module.exports = { createCreditNote, writeOff, cancelNote, getNote, listNotes, priceLines };
