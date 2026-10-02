const mongoose = require('mongoose');
const AuditLog = require('./audit.model');

const MAX_TEXT = 2000;
const HIDDEN_KEY = /password|token|secret|hash/i;
const IGNORED_FIELDS = new Set(['_id', '__v', 'createdAt', 'updatedAt', 'passwordHash', 'password']);

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitize(value, depth = 0) {
  if (value == null) return value;
  if (depth > 6) return '[…]';
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (Buffer.isBuffer(value)) return '[file]';
  if (Array.isArray(value)) {
    const list = value.slice(0, 50).map((item) => sanitize(item, depth + 1));
    if (value.length > 50) list.push(`… ${value.length - 50} more`);
    return list;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (HIDDEN_KEY.test(key)) {
        out[key] = '[hidden]';
        continue;
      }
      out[key] = sanitize(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > MAX_TEXT) return `${value.slice(0, MAX_TEXT)}…`;
  return value;
}

function comparable(value) {
  if (value === undefined) return null;
  const clean = sanitize(value);
  if (clean !== null && typeof clean === 'object') {
    const text = JSON.stringify(clean);
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : clean;
  }
  return clean;
}

function diff(before, after) {
  const changes = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const field of keys) {
    if (IGNORED_FIELDS.has(field) || HIDDEN_KEY.test(field)) continue;
    const prev = comparable(before ? before[field] : undefined);
    const next = comparable(after ? after[field] : undefined);
    if (JSON.stringify(prev) === JSON.stringify(next)) continue;
    changes.push({ field, before: prev, after: next });
  }
  return changes.slice(0, 80);
}

async function record(entry) {
  try {
    await AuditLog.create(entry);
  } catch (error) {
    console.error('Audit log write failed', error.message);
  }
}

function toPublic(log) {
  return {
    id: String(log._id),
    at: log.at,
    actorId: log.actor ? String(log.actor) : '',
    actorName: log.actorName || '',
    actorRole: log.actorRole || '',
    method: log.method,
    path: log.path,
    module: log.module,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    entityLabel: log.entityLabel,
    summary: log.summary,
    status: log.status,
    success: log.success,
    error: log.error || '',
    ip: log.ip || '',
    userAgent: log.userAgent || '',
    changes: log.changes || [],
    payload: log.payload ?? null,
  };
}

async function list(query = {}) {
  const filter = {};
  if (query.module) filter.module = String(query.module);
  if (query.actor && mongoose.isValidObjectId(query.actor)) filter.actor = query.actor;
  if (query.entityId) filter.entityId = String(query.entityId);
  if (query.outcome === 'success') filter.success = true;
  if (query.outcome === 'failed') filter.success = false;
  const day = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : '');
  const from = day(query.from) ? new Date(`${day(query.from)}T00:00:00.000+05:30`) : query.from ? new Date(query.from) : null;
  const to = day(query.to) ? new Date(`${day(query.to)}T23:59:59.999+05:30`) : query.to ? new Date(query.to) : null;
  if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
    filter.at = {};
    if (from && !Number.isNaN(from.getTime())) filter.at.$gte = from;
    if (to && !Number.isNaN(to.getTime())) filter.at.$lte = to;
  }
  if (query.q) {
    const rx = new RegExp(escapeRegex(String(query.q).trim().slice(0, 100)), 'i');
    filter.$or = [{ summary: rx }, { entityLabel: rx }, { actorName: rx }, { action: rx }, { path: rx }];
  }

  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
  const page = Math.max(Number(query.page) || 1, 1);
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ at: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  return {
    items: items.map(toPublic),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
    limit,
  };
}

async function meta() {
  const [modules, actors] = await Promise.all([
    AuditLog.distinct('module'),
    AuditLog.aggregate([
      { $match: { actor: { $ne: null } } },
      { $group: { _id: '$actor', name: { $last: '$actorName' } } },
      { $sort: { name: 1 } },
    ]),
  ]);
  return {
    modules: modules.filter(Boolean).sort(),
    actors: actors.map((row) => ({ id: String(row._id), name: row.name || 'Unknown' })),
  };
}

module.exports = { record, diff, sanitize, list, meta };
