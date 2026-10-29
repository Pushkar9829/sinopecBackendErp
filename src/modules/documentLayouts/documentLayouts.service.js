const crypto = require('crypto');
const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { isSuperAdmin, hasPermission } = require('../../utils/permissions');
const { DOCUMENTS, DOCUMENT_BY_ID, ORDER_DOC_FIELDS } = require('./documentLayouts.registry');

// The owner's changes to each document, on top of the registry defaults.
// One settings record; `layouts` is keyed by document id.
const settingsSchema = new mongoose.Schema(
  { key: { type: String, default: 'default', unique: true }, layouts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) } },
  { timestamps: true, minimize: false }
);
const DocumentLayoutSettings = mongoose.models.DocumentLayoutSettings || mongoose.model('DocumentLayoutSettings', settingsSchema);

const LABEL_MAX = 80;
const TEXT_MAX = 500;
const CUSTOM_KEY = /^c_[a-z0-9]{6,16}$/;

let cache = null;
async function saved() {
  if (!cache) {
    const doc = await DocumentLayoutSettings.findOne({ key: 'default' }).lean();
    cache = doc?.layouts || {};
  }
  return cache;
}

const clip = (value, max) => String(value ?? '').trim().slice(0, max);

// Registry parts in the owner's order, with their labels and show flags;
// parts the owner never saw (added to the registry later) go at the end.
function mergeParts(defaults, stored, { allowCustom = false } = {}) {
  const byKey = new Map(defaults.map((p) => [p.key, p]));
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(stored) ? stored : []) {
    const base = byKey.get(row?.key);
    if (base && !seen.has(base.key)) {
      seen.add(base.key);
      out.push({ key: base.key, label: row.label || base.label, defaultLabel: base.label, show: typeof row.show === 'boolean' ? row.show : base.show, custom: false });
    } else if (allowCustom && row?.custom && CUSTOM_KEY.test(row.key || '') && !seen.has(row.key)) {
      seen.add(row.key);
      out.push({ key: row.key, label: row.label, defaultLabel: '', show: row.show !== false, custom: true, source: row.source === 'order' ? 'order' : 'fixed', text: row.text || '' });
    }
  }
  for (const base of defaults) {
    if (!seen.has(base.key)) out.push({ key: base.key, label: base.label, defaultLabel: base.label, show: base.show, custom: false });
  }
  return out;
}

function mergeLayout(doc, stored = {}) {
  return {
    id: doc.id,
    label: doc.label,
    group: doc.group,
    orderLinked: Boolean(doc.orderLinked),
    title: stored.title || doc.title,
    defaultTitle: doc.title,
    footerNote: stored.footerNote || '',
    fields: mergeParts(doc.fields, stored.fields, { allowCustom: doc.id !== 'tableExport' }),
    columns: mergeParts(doc.columns, stored.columns),
    blocks: mergeParts(doc.blocks, stored.blocks),
    changed: Object.keys(stored).length > 0,
  };
}

async function listLayouts() {
  const all = await saved();
  return DOCUMENTS.map((doc) => mergeLayout(doc, all[doc.id]));
}

function findDoc(id) {
  const doc = DOCUMENT_BY_ID.get(String(id || ''));
  if (!doc) throw new ApiError(404, 'Unknown document');
  return doc;
}

async function getLayout(id) {
  const doc = findDoc(id);
  return mergeLayout(doc, (await saved())[doc.id]);
}

function canEdit(user) {
  return isSuperAdmin(user) || hasPermission(user, 'company:update');
}

function cleanParts(defaults, rows, { custom = false, orderLinked = false } = {}) {
  if (rows === undefined) return undefined;
  if (!Array.isArray(rows)) throw new ApiError(400, 'Send the parts as a list');
  const known = new Set(defaults.map((p) => p.key));
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const label = clip(row?.label, LABEL_MAX);
    if (known.has(row?.key)) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      out.push({ key: row.key, label, show: row.show !== false });
      continue;
    }
    if (!custom || !row?.custom) continue;
    if (!label) throw new ApiError(400, 'Give every added field a name');
    const key = CUSTOM_KEY.test(row.key || '') ? row.key : `c_${crypto.randomBytes(5).toString('hex')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = row.source === 'order' ? 'order' : 'fixed';
    if (source === 'order' && !orderLinked) throw new ApiError(400, `"${label}" can only be fixed text on this document (it is not made from an order)`);
    out.push({ key, label, show: row.show !== false, custom: true, source, text: source === 'fixed' ? clip(row.text, TEXT_MAX) : '' });
  }
  if (out.filter((p) => p.custom).length > 20) throw new ApiError(400, 'At most 20 added fields on one document');
  return out;
}

async function saveLayout(user, id, payload = {}) {
  if (!canEdit(user)) throw new ApiError(403, 'Only the owner can change document layouts');
  const doc = findDoc(id);
  const next = {
    title: clip(payload.title, LABEL_MAX),
    footerNote: clip(payload.footerNote, TEXT_MAX),
    fields: cleanParts(doc.fields, payload.fields, { custom: doc.id !== 'tableExport', orderLinked: doc.orderLinked }),
    columns: cleanParts(doc.columns, payload.columns),
    blocks: cleanParts(doc.blocks, payload.blocks),
  };
  for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === '') delete next[key];
  // Columns not sent keep their default; at least one must still print.
  const shownColumn = (c) => (next.columns.find((row) => row.key === c.key)?.show ?? c.show);
  if (next.columns && doc.columns.length && !doc.columns.some(shownColumn)) throw new ApiError(400, 'Keep at least one column');
  await DocumentLayoutSettings.updateOne({ key: 'default' }, { $set: { [`layouts.${doc.id}`]: next } }, { upsert: true });
  cache = null;
  return getLayout(doc.id);
}

async function resetLayout(user, id) {
  if (!canEdit(user)) throw new ApiError(403, 'Only the owner can change document layouts');
  const doc = findDoc(id);
  await DocumentLayoutSettings.updateOne({ key: 'default' }, { $unset: { [`layouts.${doc.id}`]: '' } }, { upsert: true });
  cache = null;
  return getLayout(doc.id);
}

// Boxes the order form shows for its documents: the built-in voucher boxes
// plus every "filled on each order" field added to an order document.
async function orderFields() {
  const layouts = await listLayouts();
  const out = ORDER_DOC_FIELDS.map((f) => ({ key: f.key, label: f.label, builtIn: true }));
  const seen = new Set(out.map((f) => f.key));
  for (const layout of layouts.filter((l) => l.orderLinked)) {
    for (const f of layout.fields) {
      if (f.custom && f.source === 'order' && !seen.has(f.key)) {
        seen.add(f.key);
        out.push({ key: f.key, label: f.label, builtIn: false, documents: [layout.label] });
      } else if (f.custom && f.source === 'order') {
        out.find((o) => o.key === f.key)?.documents?.push(layout.label);
      }
    }
  }
  return out;
}

// Order values for its documents: short strings under known-shaped keys only.
const ORDER_KEY = /^(otherReferences|dispatchedThrough|destination|deliveryTerms|c_[a-z0-9]{6,16})$/;
function cleanOrderValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (!ORDER_KEY.test(key)) continue;
    const text = clip(value, TEXT_MAX);
    if (text) out[key] = text;
  }
  return out;
}

module.exports = { listLayouts, getLayout, saveLayout, resetLayout, orderFields, cleanOrderValues };
