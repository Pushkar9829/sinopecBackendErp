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
machineSchema.index({ code: 1 });

machineSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Machine', machineSchema);
