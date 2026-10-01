const mongoose = require('mongoose');

const changeSchema = new mongoose.Schema(
  {
    field: { type: String, required: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

const auditLogSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actorName: { type: String, default: '', trim: true },
    actorRole: { type: String, default: '', trim: true },
    method: { type: String, default: '', trim: true },
    path: { type: String, default: '', trim: true },
    module: { type: String, default: '', trim: true },
    action: { type: String, default: '', trim: true },
    entityType: { type: String, default: '', trim: true },
    entityId: { type: String, default: '', trim: true },
    entityLabel: { type: String, default: '', trim: true },
    summary: { type: String, default: '', trim: true },
    status: { type: Number, default: 0 },
    success: { type: Boolean, default: true },
    error: { type: String, default: '', trim: true },
    ip: { type: String, default: '', trim: true },
    userAgent: { type: String, default: '', trim: true },
    changes: { type: [changeSchema], default: [] },
    payload: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { versionKey: false }
);

auditLogSchema.index({ at: -1 });
auditLogSchema.index({ module: 1, at: -1 });
auditLogSchema.index({ actor: 1, at: -1 });
auditLogSchema.index({ entityId: 1, at: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
