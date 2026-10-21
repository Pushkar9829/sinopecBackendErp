const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// What a line of a supplier's bill or debit note is booked to: Purchases, or an
// expense account (power, freight, repairs…) from the chart of accounts.
const lineSchema = new mongoose.Schema(
  {
    description: { type: String, default: '', trim: true },
    account: { type: ObjectId, ref: 'BookAccount', default: null },
    accountName: { type: String, default: '' },
    hsnCode: { type: String, default: '', trim: true },
    quantity: { type: Number, default: 0, min: 0 },
    unit: { type: String, default: '', trim: true },
    rate: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    taxable: { type: Number, default: 0, min: 0 },
    gstPercent: { type: Number, default: 0, min: 0 },
    cgst: { type: Number, default: 0, min: 0 },
    sgst: { type: Number, default: 0, min: 0 },
    igst: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
    // Raw material lot this line paid for (optional).
    lot: { type: ObjectId, ref: 'InventoryItem', default: null },
  },
  { _id: false }
);

// A supplier's bill (kind 'purchase'), or an unpaid bill from before the app
// (kind 'opening', just a total, counted in the opening balance).
const purchaseBillSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['purchase', 'opening'], required: true },
    number: { type: String, required: true, trim: true },
    supplier: { type: ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, default: '' },
    supplierGstin: { type: String, default: '' },
    supplierBillNo: { type: String, default: '', trim: true },
    billDate: { type: Date, required: true },
    creditDays: { type: Number, default: 0, min: 0 },
    dueDate: { type: Date, required: true },
    intraState: { type: Boolean, default: true },
    lines: { type: [lineSchema], default: [] },
    taxable: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    total: { type: Number, required: true, min: 0 },
    notes: { type: String, default: '', trim: true },
    status: { type: String, enum: ['issued', 'cancelled'], default: 'issued' },
    createdBy: { type: ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    cancelledAt: { type: Date, default: null },
    cancelledByName: { type: String, default: '' },
    cancelReason: { type: String, default: '' },
  },
  { timestamps: true }
);
purchaseBillSchema.index({ number: 1 }, { unique: true });
// The same supplier bill cannot be entered twice.
purchaseBillSchema.index({ supplier: 1, supplierBillNo: 1 }, { unique: true, partialFilterExpression: { status: 'issued', supplierBillNo: { $gt: '' } } });
purchaseBillSchema.index({ supplier: 1, status: 1, dueDate: 1 });
purchaseBillSchema.index({ billDate: -1 });

// Money paid to a supplier: against one bill, or their oldest bills first.
const supplierPaymentSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true },
    supplier: { type: ObjectId, ref: 'Supplier', required: true },
    bill: { type: ObjectId, ref: 'PurchaseBill', default: null },
    paidAt: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, default: 'bank_transfer' },
    // Cash or bank account it was paid from (books).
    fromAccount: { type: ObjectId, ref: 'BookAccount', default: null },
    reference: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    createdBy: { type: ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    voidedAt: { type: Date, default: null },
    voidedByName: { type: String, default: '' },
    voidReason: { type: String, default: '' },
  },
  { timestamps: true }
);
supplierPaymentSchema.index({ supplier: 1, voidedAt: 1, paidAt: 1 });

// A purchase return or rate difference: lowers what is owed to the supplier
// and the input GST taken.
const debitNoteSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true },
    supplier: { type: ObjectId, ref: 'Supplier', required: true },
    bill: { type: ObjectId, ref: 'PurchaseBill', default: null },
    date: { type: Date, required: true },
    intraState: { type: Boolean, default: true },
    lines: { type: [lineSchema], default: [] },
    taxable: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    total: { type: Number, required: true, min: 0 },
    reason: { type: String, default: '', trim: true },
    status: { type: String, enum: ['issued', 'cancelled'], default: 'issued' },
    createdBy: { type: ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },
  },
  { timestamps: true }
);
debitNoteSchema.index({ supplier: 1, status: 1 });

const PurchaseBill = mongoose.models.PurchaseBill || mongoose.model('PurchaseBill', purchaseBillSchema);
const SupplierPayment = mongoose.models.SupplierPayment || mongoose.model('SupplierPayment', supplierPaymentSchema);
const DebitNote = mongoose.models.DebitNote || mongoose.model('DebitNote', debitNoteSchema);

module.exports = { PurchaseBill, SupplierPayment, DebitNote };
