const { readStoredObject } = require('../../utils/storage');
const { getSettings } = require('./intake.settings');
const ai = require('./ai');
const { conversationText } = require('./intake.text');

const MAX_PDF_TEXT = 20000;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const READABLE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function emptyProposal(warnings = []) {
  return {
    customer: {
      name: '',
      companyName: '',
      mobile: '',
      email: '',
      gstNumber: '',
      billingAddress: '',
      shippingAddress: '',
    },
    lines: [],
    deliveryDate: '',
    notes: '',
    certainty: { customer: 'missing', lines: 'missing' },
    isOrder: true,
    warnings,
  };
}

async function pdfText(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buffer);
    return String(parsed.text || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProposal(raw, extraWarnings = []) {
  const base = emptyProposal(extraWarnings);
  const customer = raw?.customer && typeof raw.customer === 'object' ? raw.customer : {};
  base.customer = {
    name: String(customer.name || ''),
    companyName: String(customer.companyName || ''),
    mobile: String(customer.mobile || ''),
    email: String(customer.email || ''),
    gstNumber: String(customer.gstNumber || ''),
    billingAddress: String(customer.billingAddress || ''),
    shippingAddress: String(customer.shippingAddress || ''),
  };
  base.lines = Array.isArray(raw?.lines)
    ? raw.lines.map((line) => ({
        product: String(line?.product || ''),
        quantity: numberOrNull(line?.quantity),
        unit: String(line?.unit || ''),
        rate: numberOrNull(line?.rate),
        material: String(line?.material || ''),
        width: String(line?.width || ''),
        length: String(line?.length || ''),
        notes: String(line?.notes || ''),
      }))
    : [];
  base.deliveryDate = String(raw?.deliveryDate || '');
  base.notes = String(raw?.notes || '');
  const level = (value) => (['high', 'medium', 'low', 'missing'].includes(value) ? value : 'missing');
  base.certainty = {
    customer: level(raw?.certainty?.customer),
    lines: level(raw?.certainty?.lines),
  };
  base.isOrder = raw?.isOrder !== false;
  const warnings = []
    .concat(extraWarnings)
    .concat(Array.isArray(raw?.warnings) ? raw.warnings.map(String) : []);
  base.warnings = warnings.filter(Boolean);
  return base;
}

const SIZE_UNIT = '(?:inches|inch|in|cm|mm)?';
const SIZE_PATTERN = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*${SIZE_UNIT}\\s*[*x×]\\s*(\\d+(?:\\.\\d+)?)\\s*${SIZE_UNIT}(?:\\s*[*x×]\\s*(\\d+(?:\\.\\d+)?)\\s*${SIZE_UNIT})?`,
  'i'
);
const MONTH_WORD = /^(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)$/i;

function addressIn(value) {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : '';
}

function blank(value) {
  return value === null || value === undefined || value === '' || Number.isNaN(value);
}

function findSize(text) {
  const match = String(text || '').match(SIZE_PATTERN);
  if (!match) return null;
  return { width: match[1], length: match[2], gusset: match[3] || '' };
}

function findQuantity(text) {
  const cleaned = String(text || '').replace(new RegExp(SIZE_PATTERN.source, 'gi'), ' ');
  const withUnit = cleaned.match(/\b(\d{1,7}(?:\.\d+)?)\s*(pcs|pc|pieces|piece|nos|kg|kgs|packets?|pkt|rolls?)\b/i);
  if (withUnit) return { quantity: Number(withUnit[1]), unit: withUnit[2].toLowerCase() };
  const loose = cleaned.matchAll(/\b(\d{1,7})\s+([A-Za-z]{3,})/g);
  for (const match of loose) {
    if (MONTH_WORD.test(match[2])) continue;
    const before = cleaned.slice(Math.max(0, match.index - 16), match.index);
    if (/\b(rate|rs|inr|gst|rupees?)\s*$/i.test(before)) continue;
    const quantity = Number(match[1]);
    if (quantity >= 1900 && quantity <= 2100) continue;
    return { quantity, unit: '' };
  }
  return null;
}

function productBeside(text, quantity) {
  const match = String(text || '').match(new RegExp(`\\b${quantity}\\s+([^\\n(]{2,80})`, 'i'));
  if (!match) return '';
  return match[1]
    .replace(new RegExp(SIZE_PATTERN.source, 'gi'), ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
}

function applyMessageFacts(proposal, doc) {
  const text = messageText(doc);
  const senderEmail = addressIn(doc?.sender?.email);
  const senderPhone = String(doc?.sender?.phone || '').trim();
  if (senderEmail && !proposal.customer.email) proposal.customer.email = senderEmail;
  if (senderPhone && !proposal.customer.mobile) proposal.customer.mobile = senderPhone;
  if (!proposal.customer.name && doc?.sender?.name) proposal.customer.name = String(doc.sender.name).trim();

  const size = findSize(text);
  const counted = findQuantity(text);
  if (!proposal.lines.length && (size || counted)) {
    proposal.lines.push({
      product: counted ? productBeside(text, counted.quantity) : '',
      quantity: counted ? counted.quantity : null,
      unit: counted?.unit || '',
      rate: null,
      material: '',
      width: '',
      length: '',
      notes: '',
    });
  }

  if (proposal.lines.length !== 1) return proposal;
  const line = proposal.lines[0];
  if (counted && blank(line.quantity)) {
    line.quantity = counted.quantity;
    if (!line.unit && counted.unit) line.unit = counted.unit;
  }
  if (!line.product && counted) line.product = productBeside(text, counted.quantity);
  if (size && !line.width && !line.length) {
    line.width = size.width;
    line.length = size.length;
    if (size.gusset && !/gusset/i.test(line.notes)) {
      line.notes = [line.notes, `gusset ${size.gusset}`].filter(Boolean).join('. ');
    }
  }
  return proposal;
}

// The conversation as the reader sees it, rebuilt from the stored messages.
function messageText(doc) {
  return doc?.messages?.length ? conversationText(doc.messages) : String(doc?.rawBody || '');
}

// Builds what the AI reader sees: sender, message text, and the files it can read.
async function buildInput(doc, providerName) {
  const warnings = [];
  const texts = [];
  const files = [];
  const senderBits = [doc.sender?.name, addressIn(doc.sender?.email) || doc.sender?.email, doc.sender?.phone].filter(Boolean);
  if (senderBits.length) texts.push(`Sender from the channel: ${senderBits.join(', ')}`);
  if (doc.subject) texts.push(`Subject: ${doc.subject}`);
  const body = messageText(doc);
  if (body) texts.push(`Message:
${body}`);

  for (const file of doc.files || []) {
    const name = file.originalName || 'a file';
    if (!file.key) continue;
    if (file.size > MAX_FILE_BYTES) {
      warnings.push(`${name} is too large to read.`);
      continue;
    }
    let buffer = null;
    try {
      buffer = await readStoredObject(file.key, file.storage || 'local');
    } catch {
      buffer = null;
    }
    if (!buffer || !buffer.length) {
      warnings.push(`Could not open ${name}`);
      continue;
    }
    const mime = String(file.mimeType || '').toLowerCase();
    if (mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) {
      const text = await pdfText(buffer);
      if (text.length > 40) {
        texts.push(`Text extracted from ${name}:
${text.slice(0, MAX_PDF_TEXT)}`);
      } else if (ai.providerSupportsPdf(providerName)) {
        files.push({ name, mimeType: 'application/pdf', base64: buffer.toString('base64') });
        warnings.push(`${name} had no text layer, so the pages were read as images.`);
      } else {
        warnings.push(`${name} is a scanned PDF; the selected reader can't read scans.`);
      }
    } else if (READABLE_IMAGES.has(mime)) {
      files.push({ name, mimeType: mime, base64: buffer.toString('base64') });
    } else if (mime.startsWith('audio/')) {
      warnings.push('A voice note was stored. It was not read as the order.');
    } else {
      warnings.push(`${name} was stored and not read.`);
    }
  }
  return { texts, files, warnings };
}

// Returns { proposal, provider, model, warning } or throws.
async function readIntake(doc) {
  const settings = await getSettings();
  const input = await buildInput(doc, settings.aiProvider || 'gemini');
  const hasContent = Boolean(messageText(doc) || doc.subject) || input.files.length || input.texts.length > 1;
  if (!hasContent) {
    if (!input.warnings.length) throw new Error('There is nothing to read on this draft');
    return { proposal: emptyProposal(input.warnings), provider: '', model: '' };
  }
  const result = await ai.readOrder(settings, input, doc._id);
  const warnings = result.warning ? [...input.warnings, result.warning] : input.warnings;
  return {
    proposal: applyMessageFacts(normalizeProposal(result.raw, warnings), doc),
    provider: result.provider,
    model: result.model,
  };
}

module.exports = {
  readIntake,
  normalizeProposal,
  emptyProposal,
};
