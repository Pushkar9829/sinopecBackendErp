const mongoose = require('mongoose');

// A bill the customer owes: a tax invoice made at dispatch ('sale'), or an
// unpaid bill from before the app was used ('opening').
const lineSchema = new mongoose.Schema(
  {
    itemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Set on a charge line (freight...) copied from the order's charges.
    chargeId: { type: mongoose.Schema.Types.ObjectId, default: null },
    product: { type: String, default: '', trim: true },
    productCode: { type: String, default: '', trim: true },
    hsnCode: { type: String, default: '', trim: true },
    quantity: { type: Number, default: 0, min: 0 },
    unit: { type: String, default: 'pcs', trim: true },
    rate: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    taxable: { type: Number, default: 0, min: 0 },
    gstPercent: { type: Number, default: 0, min: 0 },
    cgst: { type: Number, default: 0, min: 0 },
    sgst: { type: Number, default: 0, min: 0 },
    igst: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const partySchema = new mongoose.Schema(
  {
    name: { type: String, default: '' },
    companyName: { type: String, default: '' },
    gstin: { type: String, default: '' },
    stateCode: { type: String, default: '' },
    address: { type: String, default: '' },
    shippingAddress: { type: String, default: '' },
    mobile: { type: String, default: '' },
    email: { type: String, default: '' },
    code: { type: String, default: '' },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['sale', 'opening'], required: true },
    // Sale invoices: the app's series (SP/26-27/0001). Opening bills: the old bill number.
    number: { type: String, required: true, trim: true },
    financialYear: { type: String, default: '' },
    status: { type: String, enum: ['issued', 'cancelled'], default: 'issued' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    buyer: { type: partySchema, default: () => ({}) },
    // Seller details as they were when the invoice was made.
    seller: { type: mongoose.Schema.Types.Mixed, default: null },
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', default: null },
    orderNumber: { type: String, default: '' },
    poNumber: { type: String, default: '' },
    poDate: { type: Date, default: null },
    orderType: { type: String, default: '' },
    invoiceDate: { type: Date, required: true },
    creditDays: { type: Number, default: 0, min: 0 },
    dueDate: { type: Date, required: true },
    intraState: { type: Boolean, default: true },
    placeOfSupply: { type: String, default: '' },
    lines: { type: [lineSchema], default: [] },
    taxable: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    total: { type: Number, required: true, min: 0 },
    notes: { type: String, default: '', trim: true },
    // The order's document values (Dispatched through, Destination...) when billed.
    documentFields: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    paymentTerms: { type: String, default: '' },
    // The owner billed more than was dispatched (e.g. goods held for the customer), and why.
    billAhead: { type: Boolean, default: false },
    billAheadReason: { type: String, default: '', trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    cancelledAt: { type: Date, default: null },
    cancelledByName: { type: String, default: '' },
    cancelReason: { type: String, default: '' },
  },
  { timestamps: true }
);

// Sale invoice numbers never repeat; opening bill numbers only per customer.
invoiceSchema.index({ number: 1 }, { unique: true, partialFilterExpression: { kind: 'sale' } });
invoiceSchema.index({ customer: 1, kind: 1, number: 1 }, { unique: true, partialFilterExpression: { kind: 'opening', status: 'issued' } });
invoiceSchema.index({ customer: 1, status: 1, dueDate: 1 });
invoiceSchema.index({ salesOrder: 1, status: 1 });
invoiceSchema.index({ invoiceDate: -1 });
// The books sync picks up changed documents by updatedAt.
invoiceSchema.index({ updatedAt: 1 });

invoiceSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Invoice', invoiceSchema);
