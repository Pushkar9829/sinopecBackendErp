const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema(
  {
    stage: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const entrySchema = new mongoose.Schema(
  {
    stage: { type: String, required: true, trim: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    workId: { type: mongoose.Schema.Types.ObjectId, default: null },
    product: { type: String, default: '', trim: true },
    productCode: { type: String, default: '', trim: true },
    unit: { type: String, default: 'pcs', trim: true },
    inputQty: { type: Number, default: 0, min: 0 },
    outputQty: { type: Number, default: 0, min: 0 },
    wasteQty: { type: Number, default: 0, min: 0 },
    workDate: { type: Date, default: Date.now },
    notes: { type: String, default: '', trim: true },
    machineName: { type: String, default: '', trim: true },
    pickedLotName: { type: String, default: '', trim: true },
    vehicleNumber: { type: String, default: '', trim: true },
    handoverPerson: { type: String, default: '', trim: true },
    deliveryPartner: { type: String, default: '', trim: true },
    details: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    markedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    markedByName: { type: String, default: '', trim: true },
    markedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const registerSchema = new mongoose.Schema(
  {
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', required: true, unique: true },
    orderNumber: { type: String, required: true, trim: true },
    customerName: { type: String, default: '', trim: true },
    stages: { type: [stageSchema], default: [] },
    entries: { type: [entrySchema], default: [] },
  },
  { timestamps: true }
);

registerSchema.index({ orderNumber: 1 });

registerSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Register', registerSchema);
