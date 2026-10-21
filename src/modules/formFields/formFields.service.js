const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { isSuperAdmin } = require('../../utils/permissions');
const { FORMS, FORM_BY_ID, WHEN, text } = require('./formFields.registry');

// Which inputs are mandatory on each form: the owner's choices on top of the
// defaults in the registry.
const settingsSchema = new mongoose.Schema({ key: { type: String, default: 'default', unique: true }, required: { type: mongoose.Schema.Types.Mixed, default: () => ({}) } }, { timestamps: true, minimize: false });
const FormFieldSettings = mongoose.models.FormFieldSettings || mongoose.model('FormFieldSettings', settingsSchema);

let cache = null;
async function choices() {
  if (!cache) {
    const doc = await FormFieldSettings.findOne({ key: 'default' }).lean();
    cache = doc?.required || {};
  }
  return cache;
}

function isRequired(saved, form, f) {
  if (f.locked) return true;
  const choice = saved?.[form.id]?.[f.key];
  return typeof choice === 'boolean' ? choice : f.default;
}

async function getRules() {
  const saved = await choices();
  return FORMS.map((form) => ({
    id: form.id,
    label: form.label,
    checkedOn: form.checkedOn,
    fields: form.fields.map((f) => ({ key: f.key, label: f.label, required: isRequired(saved, form, f), locked: f.locked, default: f.default || f.locked, when: f.when || null, whenLabel: f.when ? WHEN[f.when].label : '' })),
  }));
}

async function saveRules(user, required = {}) {
  if (!isSuperAdmin(user)) throw new ApiError(403, 'Only the owner can change which inputs are mandatory');
  const clean = {};
  for (const form of FORMS) {
    const wanted = required?.[form.id];
    if (!wanted || typeof wanted !== 'object') continue;
    clean[form.id] = {};
    for (const f of form.fields) {
      if (!f.locked && typeof wanted[f.key] === 'boolean') clean[form.id][f.key] = wanted[f.key];
    }
  }
  const current = await choices();
  const merged = { ...current };
  for (const [formId, values] of Object.entries(clean)) merged[formId] = { ...(current[formId] || {}), ...values };
  await FormFieldSettings.findOneAndUpdate({ key: 'default' }, { $set: { required: merged } }, { upsert: true });
  cache = null;
  return getRules();
}

// Labels of the mandatory inputs that are empty in `value` (for one form).
async function missing(formId, value) {
  const form = FORM_BY_ID.get(formId);
  const saved = await choices();
  return form.fields
    .filter((f) => isRequired(saved, form, f))
    .filter((f) => !f.when || WHEN[f.when].test(value))
    .filter((f) => text(f.get(value)) === '')
    .map((f) => f.label.replace(/ \(more than 0\)$/, '').toLowerCase());
}

async function assertComplete(formId, value, noun) {
  const gaps = await missing(formId, value);
  if (gaps.length) throw new ApiError(400, `${noun || 'This'} needs ${gaps.join(', ')}`);
}

// Clears the cached choices (tests change them directly).
function forget() {
  cache = null;
}

module.exports = { getRules, saveRules, missing, assertComplete, forget, FormFieldSettings };
