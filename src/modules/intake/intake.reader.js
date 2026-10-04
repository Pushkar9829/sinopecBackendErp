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
Rules: leave a field as an empty string or null when it is not in the message. Do not invent width, material, GST, rate, quantity, or a delivery date. Their item code is not our product code. A weekday such as Friday is medium certainty and must also be copied into notes. Put disagreements and anything unreadable into warnings.`;

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

async function readIntake(doc) {
  const settings = await getSettings();
  if (!settings.geminiApiKey) {
    throw new Error('Gemini API key is not set. Add it in Draft orders setup.');
  }

  const warnings = [];
  const geminiParts = [{ text: PROMPT }];
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
  return normalizeProposal(raw, warnings);
}

module.exports = {
  readIntake,
};
