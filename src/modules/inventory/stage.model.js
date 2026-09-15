const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    machines: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Machine' }],
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

stageSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('InventoryStage', stageSchema);
