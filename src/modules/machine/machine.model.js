const mongoose = require('mongoose');

const machineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

machineSchema.index({ name: 1 });
// Unique among machines that have a code; case-insensitive like the service check.
machineSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { code: { $gt: '' } }, collation: { locale: 'en', strength: 2 }, name: 'code_unique_ci' }
);

machineSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Machine', machineSchema);
