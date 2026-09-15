const mongoose = require('mongoose');
const { SALES_OPTION_GROUPS } = require('../../config/constants');

const optionSchema = new mongoose.Schema(
  {
    group: {
      type: String,
      required: true,
      enum: SALES_OPTION_GROUPS.map((group) => group.id),
    },
    value: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

optionSchema.index({ group: 1, value: 1 }, { unique: true });

optionSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('SalesOption', optionSchema);
