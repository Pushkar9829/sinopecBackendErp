const mongoose = require('mongoose');

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
