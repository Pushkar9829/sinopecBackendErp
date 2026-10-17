const mongoose = require('mongoose');

// Money received from a customer outside an order: settles their oldest bills
// first, or the one bill it was made for. Payments recorded on an order stay
// on the order and count towards that order's invoices.
const receiptSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    receivedAt: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, default: 'bank_transfer' },
    reference: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    voidedAt: { type: Date, default: null },
    voidedByName: { type: String, default: '' },
    voidReason: { type: String, default: '' },
  },
  { timestamps: true }
);

receiptSchema.index({ customer: 1, voidedAt: 1, receivedAt: 1 });

receiptSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Receipt', receiptSchema);
