const { readStoredObject } = require('../../utils/storage');
const { getSettings } = require('./intake.settings');

const PROMPT = `You extract a packaging order from a customer message. The message may be Hindi, English, or both, and it may be a chat, an email, or the customer's own invoice.
Return JSON only with this shape:
{
  "customer": {"name":"","companyName":"","mobile":"","email":"","gstNumber":"","billingAddress":"","shippingAddress":""},
  "lines":[{"product":"","quantity":null,"unit":"","rate":null,"material":"","width":"","length":"","notes":""}],
  "deliveryDate":"",
  "notes":"",
  "certainty":{"customer":"high|medium|low|missing","lines":"high|medium|low|missing"},
  "warnings":[]
}
Rules:
- Leave a field empty only when the message does not contain it. Do not invent material, GST, rate, or a delivery date.
- A number written with a product is the quantity, even when the word pcs is missing and the mail only asks for a PI. "Please share the PI against 17000 Polly bag" means product Polly bag and quantity 17000. Leave unit empty when no unit is written.
- A size written as 10*14*2, 10x14x2, or 10×14×2 means width 10, length 14, and gusset 2. Put "gusset 2" in that line's notes. A two-part size such as 12x18 is width and length. These are not a rate.
- Their item code is not our product code.
- A weekday such as Friday is medium certainty and must also be copied into notes.
- When the message body has no email, copy the sender email given below into customer.email.
- Put disagreements and anything unreadable into warnings.`;

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
    warnings,
  };
}

async function pdfText(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const parsed = await pdfParse(buffer);
    return String(parsed.text || '').replace(/\s+/g, ' ').trim();
  } catch (error) {
    return '';
  }
}

function partsFromResponse(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part.text || '').join('').trim();
}

async function callGemini(settings, parts) {
  const model = settings.geminiModel || 'gemini-3.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.geminiApiKey)}`;
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (response.status === 400) {
    delete body.generationConfig.thinkingConfig;
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Gemini returned ${response.status}`;
    throw new Error(message);
  }
  const text = partsFromResponse(payload);
  if (!text) throw new Error('Gemini returned an empty reading');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Gemini did not return JSON');
  }
}

function normalizeProposal(raw, extraWarnings) {
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
        quantity: line?.quantity === null || line?.quantity === undefined || line?.quantity === '' ? null : Number(line.quantity),
        unit: String(line?.unit || ''),
        rate: line?.rate === null || line?.rate === undefined || line?.rate === '' ? null : Number(line.rate),
        material: String(line?.material || ''),
        width: String(line?.width || ''),
        length: String(line?.length || ''),
        notes: String(line?.notes || ''),
      }))
    : [];
  base.deliveryDate = String(raw?.deliveryDate || '');
  base.notes = String(raw?.notes || '');
  base.certainty = {
    customer: String(raw?.certainty?.customer || 'missing'),
    lines: String(raw?.certainty?.lines || 'missing'),
  };
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
  const text = String(doc?.rawBody || '');
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

async function readIntake(doc) {
  const settings = await getSettings();
  if (!settings.geminiApiKey) {
    throw new Error('Gemini API key is not set. Add it in Draft orders setup.');
  }

  const warnings = [];
  const geminiParts = [{ text: PROMPT }];
  const senderBits = [doc.sender?.name, addressIn(doc.sender?.email) || doc.sender?.email, doc.sender?.phone].filter(Boolean);
  if (senderBits.length) {
    geminiParts.push({ text: `Sender from the channel: ${senderBits.join(', ')}` });
  }
  if (doc.rawBody) geminiParts.push({ text: `Message:\n${doc.rawBody}` });

  for (const file of doc.files || []) {
    if (!file.key) continue;
    const buffer = await readStoredObject(file.key, file.storage || 'local');
    if (!buffer || !buffer.length) {
      warnings.push(`Could not open ${file.originalName || 'a file'}`);
      continue;
    }
    const mime = String(file.mimeType || '').toLowerCase();
    if (mime === 'application/pdf' || file.originalName?.toLowerCase().endsWith('.pdf')) {
      const text = await pdfText(buffer);
      if (text.length > 40) {
        geminiParts.push({ text: `Text extracted from ${file.originalName || 'PDF'}:\n${text.slice(0, 20000)}` });
      } else {
        geminiParts.push({
          inline_data: { mime_type: 'application/pdf', data: buffer.toString('base64') },
        });
        warnings.push(`${file.originalName || 'PDF'} had no text layer, so the pages were read as images.`);
      }
    } else if (mime.startsWith('image/')) {
      geminiParts.push({
        inline_data: { mime_type: file.mimeType, data: buffer.toString('base64') },
      });
    } else if (mime.startsWith('audio/')) {
      warnings.push('A voice note was stored. It was not read as the order.');
    } else {
      warnings.push(`${file.originalName || 'A file'} was stored and not read.`);
    }
  }

  if (geminiParts.length === 1 && !warnings.length) {
    throw new Error('There is nothing to read on this draft');
  }
  if (geminiParts.length === 1) {
    return emptyProposal(warnings);
  }

  const raw = await callGemini(settings, geminiParts);
  return applyMessageFacts(normalizeProposal(raw, warnings), doc);
}

module.exports = {
  readIntake,
};
