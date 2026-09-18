const mongoose = require('mongoose');
const { PRODUCTION_ROUTES } = require('../../config/constants');

const customerProductSchema = new mongoose.Schema(
  {
    product: { type: String, default: '', trim: true },
    productCode: { type: String, default: '', trim: true },
    productType: { type: String, default: '', trim: true },
    size: { type: String, default: '', trim: true },
    material: { type: String, default: '', trim: true },
    thickness: { type: String, default: '', trim: true },
    width: { type: String, default: '', trim: true },
    length: { type: String, default: '', trim: true },
    color: { type: String, default: '', trim: true },
    quantity: { type: Number, default: 0, min: 0 },
    unit: { type: String, default: 'pcs', trim: true },
    rate: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    taxPercent: { type: Number, default: 18, min: 0 },
    productionRoute: {
      type: String,
      required: true,
      enum: Object.values(PRODUCTION_ROUTES),
    },
    manufacturing: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    roll: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    bag: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    printing: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    holes: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    tape: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    image: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  },
  { _id: true }
);

const customerSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    companyName: { type: String, default: '', trim: true },
    contactPerson: { type: String, default: '', trim: true },
    mobile: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
    gstNumber: { type: String, default: '', trim: true },
    billingAddress: { type: String, default: '', trim: true },
    shippingAddress: { type: String, default: '', trim: true },
    priceCategory: { type: String, default: '', trim: true },
    products: { type: [customerProductSchema], default: [] },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

customerSchema.index({ name: 1 });
customerSchema.index({ companyName: 1 });

customerSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Customer', customerSchema);
