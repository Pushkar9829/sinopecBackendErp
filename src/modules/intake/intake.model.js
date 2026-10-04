const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema(
  {
    originalName: { type: String, default: '', trim: true },
    mimeType: { type: String, default: '', trim: true },
    url: { type: String, default: '', trim: true },
    key: { type: String, default: '', trim: true },
    storage: { type: String, enum: ['', 'local', 's3'], default: '' },
    size: { type: Number, default: 0 },
  },
  { _id: false }
);

const intakeSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true },
    channel: { type: String, enum: ['whatsapp', 'gmail', 'paste'], required: true },
    providerMessageId: { type: String, required: true, trim: true },
    sender: {
      phone: { type: String, default: '', trim: true },
      email: { type: String, default: '', trim: true },
      name: { type: String, default: '', trim: true },
    },
    subject: { type: String, default: '', trim: true },
    rawBody: { type: String, default: '' },
    potentialOrder: { type: Boolean, default: false },
    matchedKeywords: { type: [String], default: [] },
    files: { type: [fileSchema], default: [] },
    proposal: { type: mongoose.Schema.Types.Mixed, default: null },
    warnings: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['stored', 'received', 'reading', 'needs_review', 'reading_failed', 'discarded'],
      default: 'received',
    },
    error: { type: String, default: '' },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

intakeSchema.index({ channel: 1, providerMessageId: 1 }, { unique: true });
intakeSchema.index({ status: 1, createdAt: 1 });

intakeSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Intake', intakeSchema);
