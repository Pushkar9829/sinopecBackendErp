const mongoose = require('mongoose');

// Lowers what a customer owes. A credit note (goods returned, rate
// difference, discount after the sale) reverses sales and output GST; a
// write-off clears a debt that will not be paid, as an expense, with no GST.
const lineSchema = new mongoose.Schema(
  {
    description: { type: String, default: '', trim: true },
    hsnCode: { type: String, default: '', trim: true },
    quantity: { type: Number, default: 0, min: 0 },
    unit: { type: String, default: '', trim: true },
    taxable: { type: Number, default: 0, min: 0 },
    gstPercent: { type: Number, default: 0, min: 0 },
    cgst: { type: Number, default: 0, min: 0 },
    sgst: { type: Number, default: 0, min: 0 },
    igst: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const creditNoteSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['credit_note', 'write_off'], required: true },
    number: { type: String, required: true, unique: true, trim: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    invoiceNumber: { type: String, default: '' },
    invoiceDate: { type: Date, default: null },
    date: { type: Date, required: true },
    // Buyer and seller as they were, for the printed note and GST returns.
    buyer: { type: mongoose.Schema.Types.Mixed, default: null },
    seller: { type: mongoose.Schema.Types.Mixed, default: null },
    intraState: { type: Boolean, default: true },
    lines: { type: [lineSchema], default: [] },
    taxable: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    total: { type: Number, required: true, min: 0.01 },
    reason: { type: String, default: '', trim: true },
    status: { type: String, enum: ['issued', 'cancelled'], default: 'issued' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    cancelledAt: { type: Date, default: null },
    cancelledByName: { type: String, default: '' },
    cancelReason: { type: String, default: '' },
  },
  { timestamps: true }
);
creditNoteSchema.index({ customer: 1, status: 1, date: 1 });
creditNoteSchema.index({ date: -1 });
// The books sync picks up changed documents by updatedAt.
creditNoteSchema.index({ updatedAt: 1 });

creditNoteSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.models.CreditNote || mongoose.model('CreditNote', creditNoteSchema);
