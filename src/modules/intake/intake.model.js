const mongoose = require('mongoose');

const STATUSES = [
  'stored', // not an order; kept for search, body removed after the retention period
  'received', // waiting for the AI reader
  'reading',
  'needs_review',
  'reading_failed',
  'customer_confirmed',
  'converted',
  'discarded',
];

// Still taking new messages from the same conversation.
const OPEN_STATUSES = ['stored', 'received', 'reading', 'needs_review', 'reading_failed', 'customer_confirmed'];

const fileSchema = new mongoose.Schema(
  {
    originalName: { type: String, default: '', trim: true },
    mimeType: { type: String, default: '', trim: true },
    url: { type: String, default: '', trim: true },
    key: { type: String, default: '', trim: true },
    storage: { type: String, enum: ['', 'local', 's3'], default: '' },
    size: { type: Number, default: 0 },
  },
  { _id: true }
);

const messageSchema = new mongoose.Schema(
  {
    providerMessageId: { type: String, required: true, trim: true },
    from: { type: String, default: '', trim: true },
    fromName: { type: String, default: '', trim: true },
    subject: { type: String, default: '', trim: true },
    body: { type: String, default: '' },
    // Gmail: Message-ID header, used to thread a reply.
    headerMessageId: { type: String, default: '' },
    // Auto-generated / bulk mail is never answered automatically.
    automated: { type: Boolean, default: false },
    fileIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    receivedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const readingSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    provider: { type: String, default: '' },
    model: { type: String, default: '' },
    proposal: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: '' },
    applied: { type: Boolean, default: false },
  },
  { _id: true }
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    action: { type: String, default: '' },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const replySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    channel: { type: String, default: '' },
    to: { type: String, default: '' },
    status: { type: String, enum: ['sent', 'skipped', 'failed'], default: 'sent' },
    reason: { type: String, default: '' },
    text: { type: String, default: '' },
  },
  { _id: false }
);

const intakeSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true },
    channel: { type: String, enum: ['whatsapp', 'gmail', 'panel', 'paste'], required: true },
    // Gmail thread id, or the WhatsApp phone number.
    conversationKey: { type: String, default: '', trim: true },
    // Set while the conversation still takes new messages; unique, so two
    // messages arriving together can't open two drafts for one conversation.
    openKey: { type: String },
    messageIds: { type: [String], default: [] },
    messages: { type: [messageSchema], default: [] },
    sender: {
      phone: { type: String, default: '', trim: true },
      email: { type: String, default: '', trim: true },
      name: { type: String, default: '', trim: true },
    },
    subject: { type: String, default: '', trim: true },
    // All message text, oldest first, quoted replies removed. What the reader sees.
    rawBody: { type: String, default: '' },
    potentialOrder: { type: Boolean, default: false },
    matchedKeywords: { type: [String], default: [] },
    files: { type: [fileSchema], default: [] },
    proposal: { type: mongoose.Schema.Types.Mixed, default: null },
    // A person saved the proposal: new readings no longer overwrite it.
    humanEdited: { type: Boolean, default: false },
    newReadingAvailable: { type: Boolean, default: false },
    // A reading is queued or running.
    readPending: { type: Boolean, default: false },
    readings: { type: [readingSchema], default: [] },
    warnings: { type: [String], default: [] },
    status: { type: String, enum: STATUSES, default: 'received' },
    error: { type: String, default: '' },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerName: { type: String, default: '' },
    customerMatch: { type: mongoose.Schema.Types.Mixed, default: null },
    salesOrder: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', default: null },
    salesOrderNumber: { type: String, default: '' },
    convertingAt: { type: Date, default: null },
    discardReason: { type: String, default: '' },
    statusBeforeDiscard: { type: String, default: '' },
    replies: { type: [replySchema], default: [] },
    history: { type: [historySchema], default: [] },
    receivedAt: { type: Date, default: Date.now },
    lastMessageAt: { type: Date, default: Date.now },
    reviewDueAt: { type: Date, default: null },
    bodyRemovedAt: { type: Date, default: null },
    createdBy: { type: String, default: '', trim: true },
    editedBy: { type: String, default: '', trim: true },
    editedAt: { type: Date, default: null },
  },
  // __v is checked on every save, so two people editing one draft can't
  // silently overwrite each other.
  { timestamps: true, optimisticConcurrency: true }
);

intakeSchema.index({ channel: 1, messageIds: 1 }, { unique: true });
intakeSchema.index({ openKey: 1 }, { unique: true, sparse: true });
intakeSchema.index({ status: 1, lastMessageAt: -1 });
intakeSchema.index({ lastMessageAt: -1 });

intakeSchema.set('toJSON', {
  transform(_doc, ret) {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    delete ret.openKey;
    delete ret.messageIds;
    delete ret.convertingAt;
    for (const file of ret.files || []) {
      file.id = String(file._id);
      delete file._id;
      delete file.key;
      delete file.url;
      delete file.storage;
    }
    for (const message of ret.messages || []) {
      message.id = String(message._id);
      delete message._id;
      message.fileIds = (message.fileIds || []).map(String);
    }
    for (const reading of ret.readings || []) {
      reading.id = String(reading._id);
      delete reading._id;
    }
    return ret;
  },
});

const Intake = mongoose.model('Intake', intakeSchema);
Intake.STATUSES = STATUSES;
Intake.OPEN_STATUSES = OPEN_STATUSES;

module.exports = Intake;
