const mongoose = require('mongoose');
const { ORDER_PRIORITIES, ORDER_TYPES, TASK_CATEGORIES, TASK_STATUSES } = require('../../config/constants');

const commentSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    text: { type: String, required: true, trim: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const historySchema = new mongoose.Schema(
  {
    from: { type: String, default: '' },
    to: { type: String, default: '' },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
    note: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const taskSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    category: { type: String, enum: Object.values(TASK_CATEGORIES), default: TASK_CATEGORIES.CUSTOM },
    source: { type: String, enum: ['auto', 'manual'], default: 'manual' },
    autoKey: { type: String, default: '' },
    // Set to autoKey only while the task is open; unique so the same auto task is never opened twice.
    openKey: { type: String },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', default: null },
    orderNumber: { type: String, default: '' },
    orderType: { type: String, enum: [...Object.values(ORDER_TYPES), ''], default: '' },
    itemId: { type: String, default: '' },
    itemIndex: { type: Number, default: null },
    itemLabel: { type: String, default: '' },
    quantity: { type: Number, default: null, min: 0 },
    unit: { type: String, default: '' },
    stage: { type: String, default: '' },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assigneeName: { type: String, default: '' },
    assigneeRole: { type: String, default: '' },
    priority: { type: String, enum: Object.values(ORDER_PRIORITIES), default: ORDER_PRIORITIES.NORMAL },
    dueDate: { type: Date, default: null },
    status: { type: String, enum: Object.values(TASK_STATUSES), default: TASK_STATUSES.OPEN },
    blockedReason: { type: String, default: '' },
    comments: { type: [commentSchema], default: [] },
    history: { type: [historySchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
    completedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    completedByName: { type: String, default: '' },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

taskSchema.index({ assignee: 1, status: 1 });
taskSchema.index({ assigneeRole: 1, status: 1 });
taskSchema.index({ order: 1, status: 1 });
taskSchema.index({ createdBy: 1, status: 1 });
taskSchema.index({ dueDate: 1 });
taskSchema.index({ openKey: 1 }, { unique: true, sparse: true });

taskSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    delete ret.openKey;
    return ret;
  },
});

module.exports = mongoose.model('Task', taskSchema);
