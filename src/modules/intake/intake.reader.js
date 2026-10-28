const { readStoredObject } = require('../../utils/storage');
const { getSettings } = require('./intake.settings');
const ai = require('./ai');
const { conversationText } = require('./intake.text');
const formats = require('./intake.formats');

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
    poNumber: '',
    poDate: '',
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

function textOf(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

// "9,000", "2k", "1.5 lakh" → a number; anything unreadable → null.
function quantityOrNull(value) {
  const parsed = formats.parseQuantity(value);
  return parsed && Number.isFinite(parsed.quantity) ? parsed.quantity : null;
}

// clean: { message } tidies each line the way customers write orders (only
// for a fresh reading; a person's saved lines are kept as typed).
function normalizeProposal(raw, extraWarnings = [], clean = null) {
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
    ? raw.lines.map((line) => {
        const shaped = {
          product: String(line?.product || ''),
          quantity: quantityOrNull(line?.quantity),
          unit: String(line?.unit || ''),
          rate: numberOrNull(line?.rate),
          material: String(line?.material || ''),
          width: textOf(line?.width),
          length: textOf(line?.length),
          flap: textOf(line?.flap),
          gusset: textOf(line?.gusset),
          sizeUnit: ['inch', 'mm', 'cm'].includes(line?.sizeUnit) ? line.sizeUnit : '',
          sizeText: textOf(line?.sizeText).slice(0, 120),
          thickness: numberOrNull(line?.thickness),
          thicknessKind: ['gauge', 'micron'].includes(line?.thicknessKind) ? line.thicknessKind : '',
          notes: String(line?.notes || ''),
        };
        return clean ? formats.cleanLine(shaped, line || {}, clean.message || '') : shaped;
      })
    : [];
  base.deliveryDate = String(raw?.deliveryDate || '');
  base.poNumber = String(raw?.poNumber || '').slice(0, 60);
  base.poDate = String(raw?.poDate || '');
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

function addressIn(value) {
  const match = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : '';
}

function blank(value) {
  return value === null || value === undefined || value === '' || Number.isNaN(value);
}

function productBeside(text, quantity) {
  const plain = String(text || '').replace(/(\d),(?=\d)/g, '$1');
  const match = plain.match(new RegExp(`\b${quantity}\s*(?:pcs|pieces|nos)?\s+([^\n(]{2,80})`, 'i'));
  if (!match) return '';
  return match[1]
    .replace(formats.SIZE_PATTERN_ALL, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
}

function emptyLine() {
  return { product: '', quantity: null, unit: '', rate: null, material: '', width: '', length: '', flap: '', gusset: '', sizeUnit: '', sizeText: '', thickness: null, thicknessKind: '', notes: '' };
}

// Facts the message text itself gives: sender, and for a one-line order the
// size, quantity, thickness and features the reader left out; for the whole
// draft the PO number, references and delivery; and whether it is an order.
function applyMessageFacts(proposal, doc) {
  const text = messageText(doc);
  const senderEmail = addressIn(doc?.sender?.email);
  const senderPhone = String(doc?.sender?.phone || '').trim();
  if (senderEmail && !proposal.customer.email) proposal.customer.email = senderEmail;
  if (senderPhone && !proposal.customer.mobile) proposal.customer.mobile = senderPhone;
  if (!proposal.customer.name && doc?.sender?.name) proposal.customer.name = String(doc.sender.name).trim();

  const size = formats.parseSize(text);
  const counted = formats.findQuantity(text);
  if (!proposal.lines.length && (size || counted)) {
    proposal.lines.push({ ...emptyLine(), product: counted ? productBeside(text, counted.quantity) : '', quantity: counted ? counted.quantity : null, unit: counted?.unit || '' });
  }

  if (proposal.lines.length === 1) {
    const line = proposal.lines[0];
    if (counted && blank(line.quantity)) {
      line.quantity = counted.quantity;
      if (!line.unit && counted.unit) line.unit = counted.unit;
      if (counted.approx) line.notes = formats.mergeNotes(line.notes, ['Approx. quantity']);
    }
    if (!line.product && counted) line.product = productBeside(text, counted.quantity);
    if (size && !line.width && !line.length && !line.sizeText) line.sizeText = size.text;
    if (blank(line.thickness)) {
      const thickness = formats.findThickness(text);
      if (thickness) Object.assign(line, { thickness: thickness.value, thicknessKind: thickness.kind });
    }
    if (!line.material) line.material = formats.normalizeMaterial('', `${line.product} ${text}`);
    line.notes = formats.mergeNotes(line.notes, formats.findFeatures(text, { printing: false }));
    Object.assign(line, formats.cleanLine(line, {}, text));
  }

  if (!proposal.poNumber) proposal.poNumber = formats.findPoNumber(text).slice(0, 60);
  const references = formats.findReferences(text);
  if (references.length) proposal.notes = formats.mergeNotes(proposal.notes, references);
  const delivery = formats.findDelivery(text);
  if (delivery && !proposal.deliveryDate) {
    if (delivery.date) proposal.deliveryDate = delivery.date;
    else proposal.notes = formats.mergeNotes(proposal.notes, [delivery.note]);
  }

  const reason = formats.notOrderReason({ body: text, subject: doc?.subject, fileCount: (doc?.files || []).length, lines: proposal.lines });
  if (reason) {
    proposal.isOrder = false;
    proposal.warnings = [...proposal.warnings, reason];
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
  // An empty message with no file is not an order; the reader is not asked.
  if (!messageText(doc).trim() && !(doc.files || []).length && !input.warnings.length) {
    const proposal = applyMessageFacts(emptyProposal(), doc);
    return { proposal, provider: '', model: '' };
  }
  const hasContent = Boolean(messageText(doc) || doc.subject) || input.files.length || input.texts.length > 1;
  if (!hasContent) {
    if (!input.warnings.length) throw new Error('There is nothing to read on this draft');
    return { proposal: emptyProposal(input.warnings), provider: '', model: '' };
  }
  const result = await ai.readOrder(settings, input, doc._id);
  const warnings = result.warning ? [...input.warnings, result.warning] : input.warnings;
  return {
    proposal: applyMessageFacts(normalizeProposal(result.raw, warnings, { message: messageText(doc) }), doc),
    provider: result.provider,
    model: result.model,
  };
}

module.exports = {
  readIntake,
  applyMessageFacts,
  normalizeProposal,
  emptyProposal,
};
