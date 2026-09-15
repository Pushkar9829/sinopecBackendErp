const mongoose = require('mongoose');
const { INVENTORY_CATEGORIES } = require('../../config/constants');

const itemSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      required: true,
      enum: Object.values(INVENTORY_CATEGORIES),
    },
    name: { type: String, required: true, trim: true },
    materialType: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0, default: 0 },
    unitPrice: { type: Number, default: null, min: 0 },
    stage: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryStage', default: null },
    notes: { type: String, default: '', trim: true },
    isActive: { type: Boolean, default: true },
    kind: { type: String, enum: ['catalog', 'wip'], default: 'catalog' },
    wipStage: { type: String, default: '', trim: true },
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', default: null },
    lineItem: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

itemSchema.index({ category: 1, name: 1 });
itemSchema.index({ materialType: 1 });

itemSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('InventoryItem', itemSchema);
