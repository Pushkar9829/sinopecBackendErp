const mongoose = require('mongoose');
const { PRODUCTION_ROUTES } = require('../../config/constants');

const templateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, default: '', trim: true },
    isActive: { type: Boolean, default: true },
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
  },
  { timestamps: true }
);

templateSchema.index({ name: 1 });
templateSchema.index({ code: 1 });

templateSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('ProductTemplate', templateSchema);
