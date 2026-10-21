const mongoose = require('mongoose');
const { GROUPS } = require('./books.chart');

const { ObjectId } = mongoose.Schema.Types;

// A ledger account. Customer accounts are made by the app (one per customer);
// system accounts carry a `key` the automatic postings look up.
const accountSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    group: { type: String, required: true, enum: GROUPS.map((g) => g.id) },
    key: { type: String, default: undefined },
    customer: { type: ObjectId, ref: 'Customer', default: undefined },
    supplier: { type: ObjectId, ref: 'Supplier', default: undefined },
    // Balance on the books start date (entered once, from the CA's figures).
    openingDr: { type: Number, default: 0, min: 0 },
    openingCr: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    notes: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);
accountSchema.index({ key: 1 }, { unique: true, partialFilterExpression: { key: { $type: 'string' } } });
accountSchema.index({ customer: 1 }, { unique: true, partialFilterExpression: { customer: { $type: 'objectId' } } });
accountSchema.index({ supplier: 1 }, { unique: true, partialFilterExpression: { supplier: { $type: 'objectId' } } });
accountSchema.index({ group: 1, name: 1 });

const lineSchema = new mongoose.Schema(
  {
    account: { type: ObjectId, ref: 'BookAccount', required: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    note: { type: String, default: '', trim: true },
  },
  { _id: false }
);

// One balanced entry in the books. Automatic ones mirror a document elsewhere
// in the app (sourceKey) and change only when it does.
const voucherSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, enum: ['sales', 'receipt', 'payment', 'journal', 'contra', 'purchase', 'credit_note', 'debit_note'] },
    number: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    narration: { type: String, default: '', trim: true },
    lines: { type: [lineSchema], default: [] },
    total: { type: Number, required: true, min: 0 },
    status: { type: String, enum: ['posted', 'cancelled'], default: 'posted' },
    auto: { type: Boolean, default: false },
    sourceKey: { type: String, default: undefined },
    sourceRef: { type: String, default: '' },
    sourceLink: { type: String, default: '' },
    // Quick expense entries: who was paid and their bill, for the expense list.
    kind: { type: String, default: undefined },
    paidTo: { type: String, default: '', trim: true },
    billNo: { type: String, default: '', trim: true },
    createdBy: { type: ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    cancelledAt: { type: Date, default: null },
    cancelledByName: { type: String, default: '' },
    cancelReason: { type: String, default: '' },
  },
  { timestamps: true }
);
voucherSchema.index({ sourceKey: 1 }, { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } });
voucherSchema.index({ type: 1, number: 1 }, { unique: true });
voucherSchema.index({ date: 1, _id: 1 });
voucherSchema.index({ 'lines.account': 1, date: 1 });
voucherSchema.index({ kind: 1, date: -1 }, { partialFilterExpression: { kind: { $type: 'string' } } });

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true },
    // The day the app's books begin; opening balances are as of this day.
    startDate: { type: Date, default: () => new Date('2026-04-01T00:00:00+05:30') },
    // Nothing on or before this day can be entered or cancelled by hand.
    lockDate: { type: Date, default: null },
    defaultBank: { type: ObjectId, ref: 'BookAccount', default: null },
    // Automatic posting picks up documents changed since this moment.
    syncedUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

const BookAccount = mongoose.models.BookAccount || mongoose.model('BookAccount', accountSchema);
const Voucher = mongoose.models.Voucher || mongoose.model('Voucher', voucherSchema);
const BooksSettings = mongoose.models.BooksSettings || mongoose.model('BooksSettings', settingsSchema);

// Value of stock on hand on a day (from the stock count), entered by Accounts.
// It closes the P&L for a period ending that day and opens the next one.
const closingStockSchema = new mongoose.Schema(
  {
    day: { type: String, required: true, unique: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    value: { type: Number, required: true, min: 0 },
    note: { type: String, default: '', trim: true },
    byName: { type: String, default: '' },
  },
  { timestamps: true }
);
const ClosingStock = mongoose.models.ClosingStock || mongoose.model('ClosingStock', closingStockSchema);

// A financial year that has been closed: the books are locked to its last
// day, with the year's result kept as it was at closing.
const yearCloseSchema = new mongoose.Schema(
  {
    fy: { type: String, required: true, unique: true },
    endDay: { type: String, required: true },
    netProfit: { type: Number, default: 0 },
    closingStock: { type: Number, default: 0 },
    closedByName: { type: String, default: '' },
  },
  { timestamps: true }
);
const YearClose = mongoose.models.YearClose || mongoose.model('YearClose', yearCloseSchema);

module.exports = { BookAccount, Voucher, BooksSettings, ClosingStock, YearClose };
