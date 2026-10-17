const ApiError = require('../../utils/ApiError');
const CompanySettings = require('./company.model');

const TEXT_FIELDS = [
  'legalName',
  'address',
  'city',
  'state',
  'pinCode',
  'gstin',
  'pan',
  'udyam',
  'email',
  'phone',
  'bankName',
  'bankAccountName',
  'bankAccountNumber',
  'bankIfsc',
  'bankBranch',
  'invoicePrefix',
  'proformaPrefix',
  'defaultHsnCode',
  'invoiceTerms',
];

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

async function loadSettings() {
  let doc = await CompanySettings.findOne({ key: 'default' });
  if (!doc) {
    try {
      doc = await CompanySettings.create({ key: 'default' });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      doc = await CompanySettings.findOne({ key: 'default' });
    }
  }
  return doc;
}

function present(doc) {
  const view = {};
  for (const field of TEXT_FIELDS) view[field] = doc[field] || '';
  view.defaultCreditDays = doc.defaultCreditDays ?? 30;
  view.defaultGstPercent = doc.defaultGstPercent ?? 18;
  // First two digits of the GSTIN: decides CGST+SGST (same state) or IGST.
  view.stateCode = view.gstin ? view.gstin.slice(0, 2) : '';
  view.updatedAt = doc.updatedAt;
  return view;
}

async function getSettings() {
  return present(await loadSettings());
}

function wholeNumber(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ApiError(400, `${label} must be between ${min} and ${max}`);
  }
  return Math.round(parsed);
}

async function saveSettings(payload = {}) {
  const doc = await loadSettings();
  for (const field of TEXT_FIELDS) {
    if (payload[field] !== undefined) doc[field] = String(payload[field] ?? '').trim();
  }
  if (doc.gstin && !GSTIN.test(doc.gstin.toUpperCase())) throw new ApiError(400, 'GSTIN is not in the right format (15 characters, e.g. 07ABCDE1234F1Z5)');
  if (doc.bankIfsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(doc.bankIfsc.toUpperCase())) throw new ApiError(400, 'IFSC is not in the right format (e.g. HDFC0001234)');
  if (!/^[A-Za-z0-9/-]{0,8}$/.test(doc.invoicePrefix || '')) throw new ApiError(400, 'Invoice prefix can be up to 8 letters, digits, / or -');
  if (!/^[A-Za-z0-9/-]{0,8}$/.test(doc.proformaPrefix || '')) throw new ApiError(400, 'Proforma prefix can be up to 8 letters, digits, / or -');
  if (payload.defaultCreditDays !== undefined) doc.defaultCreditDays = wholeNumber(payload.defaultCreditDays, 'Default credit days', 0, 365);
  if (payload.defaultGstPercent !== undefined) doc.defaultGstPercent = wholeNumber(payload.defaultGstPercent, 'Default GST %', 0, 100);
  if (!doc.legalName) throw new ApiError(400, 'Legal name is required');
  await doc.save();
  return present(doc);
}

// Credit days for a customer that has none of its own.
async function defaultCreditDays() {
  return (await loadSettings()).defaultCreditDays ?? 30;
}

module.exports = { getSettings, saveSettings, defaultCreditDays };
