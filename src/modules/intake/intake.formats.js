// How customers write the plant's orders: sizes, units, quantities, gauge or
// micron, material and features. Used to tidy what the AI reader returns and
// to read plain message text when the reader found no lines.

const NUM = '(\\d+(?:\\.\\d+)?)';
const UNIT = '(mm|cm|inches|inch|in(?![a-z])|"|\'\'|”|″)';
const QTY_UNITS = 'pcs|pc|pieces|piece|nos|kgs|kg|kilograms?|kilogrammes?|kilos?|packets?|pkts?|pkt|rolls?|boxes|box|mtrs?|meters?|metres?|bundles?';
// W x L, then an optional third number after +, -, x or * ("9.5 x 13 + 2",
// "12*18-2", "10X12X2", "9.5W X14L +2\"", "9.5 by 13 + 2"). The owner
// confirmed the third number is the flap.
const SIZE_SOURCE =
  `(?<![\\d.])${NUM}\\s*${UNIT}?\\s*(?:(?:w|width)(?=\\s|[x×*]))?\\s*(?:x|×|\\*|by)\\s*${NUM}\\s*${UNIT}?\\s*(?:(?:l|length)(?![a-z]))?` +
  `(?:\\s*(?:\\+|-|–|x|×|\\*)\\s*${NUM}(?![\\d.])(?!\\s*(?:${QTY_UNITS})\\b)\\s*${UNIT}?)?`;
const SIZE_PATTERN = new RegExp(SIZE_SOURCE, 'i');
const SIZE_PATTERN_ALL = new RegExp(SIZE_SOURCE, 'gi');
const APPROX = /\b(?:approx\w*|aprox\w*|apprx|apx|appx|around|about)\b|~/i;
const FOLLOW_UP =
  /\b(?:paid|payment (?:done|made|sent|transferred|released)|cheque|pdc|porter|send (?:it |them |the goods )?via|sent via|dispatch(?:ed)? via|lr copy|transport details|goods[- ]ready|ready date|bank details|account details|utr|neft|rtgs)\b/i;
const PRODUCT_WORD = /\b(?:bags?|poly|polly|polybags?|rolls?|films?|sheets?|mailers?|pouch(?:es)?|covers?|ldpe|ld|pp|hdpe)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function sizeUnit(value) {
  const unit = text(value).toLowerCase();
  if (unit === 'mm' || unit === 'cm') return unit;
  if (['in', 'inch', 'inches', '"', "''", '”', '″'].includes(unit)) return 'inch';
  return '';
}

// "PCS-PCS-Pieces" → pcs, "Kilograms" / "KGS" → kg; other written units are kept.
const UNIT_WORDS = [
  ['pcs', /^(?:pcs?|pieces?|nos?|numbers?)$/],
  ['kg', /^(?:kgs?|kilos?|kilograms?|kilogrammes?)$/],
  ['box', /^(?:box|boxes|bx)$/],
  ['roll', /^rolls?$/],
  ['mtr', /^(?:mtrs?|meters?|metres?)$/],
  ['packet', /^(?:packets?|pkts?|packs?)$/],
  ['bundle', /^(?:bundles?|bdl)$/],
];

function normalizeUnit(value) {
  const raw = text(value);
  if (!raw) return '';
  for (const word of raw.toLowerCase().split(/[^a-z]+/).filter(Boolean)) {
    const found = UNIT_WORDS.find(([, pattern]) => pattern.test(word));
    if (found) return found[0];
  }
  return raw.toLowerCase();
}

function scaled(number, word) {
  const value = Number(number);
  const unit = text(word).toLowerCase();
  if (unit === 'k' || unit === 'thousand') return value * 1000;
  if (/^(?:lakhs?|lacs?)$/.test(unit)) return round(value * 100000);
  return value;
}

// "12500 (Aprox)", "9,000", "2k", "1.5 lakh", "4.55 KGS" → { quantity, unit, approx }.
function parseQuantity(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? { quantity: value, unit: '', approx: false } : null;
  const raw = text(value);
  if (!raw) return null;
  const clean = raw.replace(/(\d),(?=\d)/g, '$1');
  const match = clean.match(/(\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?)?(?![a-z])\s*([a-z][a-z-]*)?/i);
  if (!match) return null;
  const unit = match[3] && new RegExp(`^(?:${QTY_UNITS})`, 'i').test(match[3]) ? normalizeUnit(match[3]) : '';
  return { quantity: scaled(match[1], match[2]), unit, approx: APPROX.test(raw) };
}

// The first quantity written in free text. strict: only one with a unit or a "Qty" label.
function findQuantity(source, { strict = false } = {}) {
  const plain = String(source || '').replace(SIZE_PATTERN_ALL, ' ').replace(/(\d),(?=\d)/g, '$1');
  // "(Aprox)" is blanked to spaces of the same length, so positions still match `plain`.
  const cleaned = plain.replace(/\(\s*(?:approx\w*|aprox\w*|apx|appx)\s*\)/gi, (found) => ' '.repeat(found.length));
  // "approx" counts only next to the number (not "about the rate").
  const near = (match) => APPROX.test(plain.slice(Math.max(0, match.index - 12), match.index + match[0].length + 16));
  const withUnit = cleaned.match(new RegExp(`(?<![\\d.])(\\d+(?:\\.\\d+)?)\\s*(k|lakhs?|lacs?)?\\s*(${QTY_UNITS})\\b`, 'i'));
  if (withUnit) return { quantity: scaled(withUnit[1], withUnit[2]), unit: normalizeUnit(withUnit[3]), approx: near(withUnit) };
  const labelled = cleaned.match(/\b(?:qty|quantity)\s*[:\-=.]?\s*(\d+(?:\.\d+)?)\s*(k|lakhs?|lacs?)?(?![a-z])/i);
  if (labelled) return { quantity: scaled(labelled[1], labelled[2]), unit: '', approx: near(labelled) };
  if (strict) return null;
  for (const match of cleaned.matchAll(/\b(\d{1,7})\s+([A-Za-z]{3,})/g)) {
    const word = match[2].toLowerCase();
    if (MONTHS.includes(word.slice(0, 3)) && /^[a-z]+$/.test(word) && word.length <= 9) continue;
    if (/^(?:gauge|gauze|gage|microns?|mic|inch|inches|holes?|punch|days?|months?|years?|job|style|percent)$/.test(word)) continue;
    if (/[/\-.:#]$/.test(cleaned.slice(0, match.index))) continue;
    const before = cleaned.slice(Math.max(0, match.index - 16), match.index);
    if (/\b(rate|rs|inr|gst|rupees?)\s*$/i.test(before)) continue;
    const quantity = Number(match[1]);
    if (quantity >= 1900 && quantity <= 2100) continue;
    return { quantity, unit: '', approx: near(match) };
  }
  return null;
}

// What follows a size says whether its third number is a flap or a gusset.
function labelAfter(source, end) {
  const next = source.slice(end, end + 20);
  const label = next.match(/^\s*(?:mm|cm|inch|in|")?\s*\(?\s*(flap|gusset)/i);
  return label ? label[1].toLowerCase() : 'flap';
}

// { width, length, third, thirdLabel, unit, text } or null.
function parseSize(value) {
  const source = String(value || '');
  const match = SIZE_PATTERN.exec(source);
  if (!match) return null;
  const [whole, width, unit1, length, unit2, third, unit3] = match;
  const size = { width, length, third: '', thirdLabel: '', unit: sizeUnit(unit2) || sizeUnit(unit1) || '', text: whole.trim() };
  // A third number as big as the length is not a flap (e.g. a year or a quantity).
  if (third && Number(third) < Number(length)) {
    size.third = third;
    size.thirdLabel = labelAfter(source, match.index + whole.length);
    size.unit = size.unit || sizeUnit(unit3);
  }
  return size;
}

// "flap 2", "gusset: 50 MM" → { value, unit }.
function labelled(source, word) {
  const match = String(source || '').match(new RegExp(`\\b${word}\\s*(?:of|:|-|=)?\\s*${NUM}\\s*${UNIT}?`, 'i'));
  return match ? { value: match[1], unit: sizeUnit(match[2]) } : null;
}

// "9.5W", "520 mm", "14\"" → { value, unit }; anything else → null.
function measure(value) {
  const match = text(value).match(/^(\d+(?:\.\d+)?)\s*(mm|cm|inches|inch|in|"|''|”|″|w|l|width|length)?\.?$/i);
  if (!match) return null;
  return { value: match[1], unit: sizeUnit(match[2]) };
}

// One size for a roll, sheet or film: "24 INCH", "24\"", "19 INCH STRETCH FILM".
function singleWidth(source) {
  for (const match of String(source || '').matchAll(new RegExp(`(?<![\\d.x×*])${NUM}\\s*${UNIT}`, 'gi'))) {
    const before = source.slice(Math.max(0, match.index - 20), match.index);
    if (/(adhesive|tape|hole|flap|gusset|strip)\W*$/i.test(before)) continue;
    return { value: match[1], unit: sizeUnit(match[2]) };
  }
  return null;
}

const GAUGE = /(?<![\d.])(\d+(?:\.\d+)?)\s*(?:gauge|gauze|gage|ga)(?![a-z])|\b(?:gauge|gauze)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i;
const MICRON = /(?<![\d.])(\d+(?:\.\d+)?)\s*(?:microns?|mic|mu|µm?|um)(?![a-z])|\bmicrons?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i;
// "POLYBAG LD NORMAL PRINTED 160G": grams-style gauge in a bag name.
const GRAM_GAUGE = /(?<![\w.])(\d{2,3})\s?G(?![a-z0-9])/i;

function findThickness(source) {
  const value = String(source || '');
  const gauge = value.match(GAUGE);
  if (gauge) return { value: Number(gauge[1] || gauge[2]), kind: 'gauge' };
  const micron = value.match(MICRON);
  if (micron) return { value: Number(micron[1] || micron[2]), kind: 'micron' };
  return null;
}

function gramGauge(product) {
  if (!/bag|poly|cover|pouch|\bld\b|\bpp\b/i.test(product)) return null;
  const match = String(product || '').match(GRAM_GAUGE);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= 50 && value <= 800 ? { value, kind: 'gauge', token: match[0] } : null;
}

// LD/LDPE → LDPE, PP → PP; recycled / RCS and a percentage are kept.
function normalizeMaterial(value, context = '') {
  let material = text(value)
    .replace(GAUGE, ' ')
    .replace(MICRON, ' ')
    .replace(/(?<![a-z])l\.?d\.?(?:p\.?e\.?)?(?![a-z])/gi, 'LDPE')
    .replace(/(?<![a-z])pp(?![a-z])/gi, 'PP')
    .replace(/\s+/g, ' ')
    .trim();
  const extra = String(context || '');
  if (!material) {
    if (/\bLLDPE\b/i.test(extra)) material = 'LLDPE';
    else if (/\bHDPE\b/i.test(extra)) material = 'HDPE';
    else if (/(?<![a-z])(?:LDPE|LD)(?![a-z])/i.test(extra)) material = 'LDPE';
    else if (/\bBOPP\b/i.test(extra)) material = 'BOPP';
    else if (/(?<![a-z])PP(?![a-z])|polypropylene/i.test(extra)) material = 'PP';
  }
  // "RECYCLE LDPE" → "LDPE, recycled".
  if (/\brecycl\w*\b/i.test(material) && !/%/.test(material)) {
    const base = material.replace(/\brecycl\w*\b/gi, ' ').replace(/\s+/g, ' ').replace(/^[\s,]+|[\s,]+$/g, '').trim();
    material = [base, 'recycled'].filter(Boolean).join(', ');
  }
  const all = `${material} ${extra}`;
  if (!/recycl|\bRCS\b/i.test(material)) {
    const percent = all.match(/(\d{1,3})\s*%\s*(?:of\s+)?(?:recycled|recycle|rcs)/i);
    if (percent) material = [material, `${percent[1]}% recycled`].filter(Boolean).join(', ');
    else if (/\brecycled\b|\bRCS\b/i.test(all)) material = [material, /\bRCS\b/i.test(all) ? 'recycled (RCS)' : 'recycled'].filter(Boolean).join(', ');
  }
  return material;
}

const COUNT_WORDS = { one: 1, single: 1, two: 2, double: 2, three: 3, four: 4 };

// Adhesive, holes, tube hole, printed / plain, blister as short notes.
function findFeatures(source, { printing = true } = {}) {
  const value = String(source || '');
  const found = [];
  const adhesive = value.match(/\b(self[\s-]*)?adhesive(?:\s*(?:tape|strip))?(?:\s*(?:of|-|:)?\s*(\d+(?:\.\d+)?)\s*mm)?/i);
  const adhesiveBefore = value.match(/(\d+(?:\.\d+)?)\s*mm\s*(self[\s-]*)?adhesive/i);
  if (adhesive || adhesiveBefore) {
    const self = adhesive?.[1] || adhesiveBefore?.[2];
    const mm = adhesive?.[2] || adhesiveBefore?.[1];
    found.push(`${self ? 'Self-adhesive' : 'Adhesive'}${mm ? ` ${mm} mm` : ''}`);
  }
  const holes = value.match(/\b(\d+|one|single|two|double|three|four)\s*(punch(?:ed)?\s*)?holes?\b/i);
  if (holes) {
    const count = COUNT_WORDS[holes[1].toLowerCase()] || Number(holes[1]);
    found.push(`${count} ${holes[2] ? 'punch ' : ''}hole${count === 1 ? '' : 's'}`);
  }
  if (/\btube\s*hole\b/i.test(value)) found.push('Tube hole');
  if (printing) {
    if (/\bplain\b|\bunprinted\b|\bnon[\s-]?printed\b/i.test(value)) found.push('Plain');
    else if (/\bprinted\b/i.test(value)) found.push('Printed');
  }
  if (/\bblister\b/i.test(value)) found.push('Blister');
  return found;
}

// Already in the notes in the customer's own words?
function noted(notes, add) {
  if (/^approx/i.test(add)) return /approx|aprox/i.test(notes);
  if (/adhesive/i.test(add)) return /adhesive/i.test(notes);
  if (add === 'Tube hole') return /tube\s*hole/i.test(notes);
  if (/\bholes?$/.test(add)) return /\d+\s*(?:punch(?:ed)?\s*)?holes?/i.test(notes);
  if (['Printed', 'Plain', 'Blister'].includes(add)) return new RegExp(`\\b${add}\\b`, 'i').test(notes);
  return notes.toLowerCase().includes(add.toLowerCase());
}

// Adds notes that are not there yet, joined tidily.
function mergeNotes(existing, additions) {
  let notes = text(existing);
  for (const add of additions) {
    if (add && !noted(notes, add)) notes = [notes.replace(/[.\s]+$/, ''), add].filter(Boolean).join('. ');
  }
  return notes;
}

function withUnit(value, unit) {
  return unit && unit !== 'inch' ? `${value} ${unit}` : value;
}

// Tidies one line read by the AI. `raw` is the line as the model sent it;
// `message` is the whole message text (a gusset is only kept when the
// message says gusset somewhere).
function cleanLine(line, raw = {}, message = '') {
  const out = { ...line };
  const notes = [];
  const counted = parseQuantity(raw.quantity);
  if (counted) {
    out.quantity = counted.quantity;
    if (!out.unit && counted.unit) out.unit = counted.unit;
    if (counted.approx) notes.push('Approx. quantity');
  }
  out.unit = normalizeUnit(out.unit);

  const context = [out.sizeText, out.product, out.notes].filter(Boolean).join(' | ');
  const stuffed = /[x×*]|\bby\b/i.test(out.width) ? out.width : '';
  let size = [out.sizeText, stuffed, out.product, out.notes].map(parseSize).find(Boolean) || null;
  if (!size?.third && message) {
    const w = measure(out.width)?.value;
    const l = measure(out.length)?.value;
    const fromMessage = (String(message).match(SIZE_PATTERN_ALL) || [])
      .map(parseSize)
      .find((found) => found && found.third && (!w || Number(found.width) === Number(w)) && (!l || Number(found.length) === Number(l)));
    if (fromMessage && (size === null || (Number(size.width) === Number(fromMessage.width) && Number(size.length) === Number(fromMessage.length)))) size = fromMessage;
  }
  if (size && !out.sizeText) out.sizeText = size.text;
  let width = measure(out.width);
  let length = measure(out.length);
  if (size && (!width || !length)) {
    width = { value: size.width, unit: size.unit };
    length = { value: size.length, unit: size.unit };
  }
  if (!size && !width && /roll|sheet|film|stretch/i.test(`${out.product} ${out.sizeText}`)) {
    const single = singleWidth(out.sizeText) || singleWidth(out.product) || singleWidth(out.notes);
    if (single) {
      width = single;
      if (!out.sizeText) out.sizeText = `${single.value} ${single.unit || 'inch'}`;
    }
  }
  if (width) out.width = width.value;
  if (length) out.length = length.value;

  // Third number of a W x L + N size: the flap, unless it says gusset.
  const flapValue = measure(out.flap);
  const gussetValue = measure(out.gusset);
  out.flap = flapValue ? flapValue.value : text(out.flap);
  out.gusset = gussetValue ? gussetValue.value : text(out.gusset);
  if (size?.third) {
    const field = size.thirdLabel === 'gusset' ? 'gusset' : 'flap';
    if (!out.flap && !out.gusset) out[field] = size.third;
    else if (field === 'flap' && !out.flap && out.gusset === size.third) {
      out.flap = size.third;
      out.gusset = '';
    }
  }
  const namedFlap = labelled(context, 'flap');
  const namedGusset = labelled(context, 'gusset');
  if (namedFlap && !out.flap) out.flap = namedFlap.value;
  if (namedGusset && !out.gusset) out.gusset = namedGusset.value;
  const customerWords = message ? String(message) : context;
  if (out.gusset && !/gusset/i.test(customerWords)) {
    // Gusset only when the customer wrote the word.
    if (!out.flap) out.flap = out.gusset;
    else if (out.flap !== out.gusset) notes.push(`gusset ${out.gusset}?`);
    out.notes = text(out.notes)
      .replace(new RegExp(`\\bgusset\\s*[:\\-]?\\s*${String(out.gusset).replace('.', '\\.')}\\s*(?:"|inch|in)?\\.?`, 'i'), '')
      .replace(/^[\s.,;]+|[\s,;]+$/g, '')
      .trim();
    out.gusset = '';
  }

  out.sizeUnit =
    sizeUnit(out.sizeUnit) || width?.unit || length?.unit || size?.unit || flapValue?.unit || namedGusset?.unit || gussetValue?.unit || '';
  if (!out.sizeUnit && (out.width || out.length)) out.sizeUnit = 'inch';
  // Values that can't be right (a PO table read into the wrong column).
  for (const [field, limit] of [
    ['flap', out.length],
    ['gusset', out.width],
  ]) {
    if (!out[field]) continue;
    const value = Number(out[field]);
    if (!Number.isFinite(value) || value <= 0 || (Number(limit) > 0 && value >= Number(limit))) {
      notes.push(`Check ${field}: ${out[field]} was read`);
      out[field] = '';
    }
  }

  // Thickness: gauge or micron.
  const gram = gramGauge(out.product);
  const given = raw.thickness !== undefined ? raw.thickness : out.thickness;
  let thickness = null;
  if (typeof given === 'number' && given > 0) thickness = { value: given, kind: ['gauge', 'micron'].includes(out.thicknessKind) ? out.thicknessKind : '' };
  else if (text(given)) thickness = findThickness(text(given)) || (Number(text(given)) > 0 ? { value: Number(text(given)), kind: '' } : null);
  if (!thickness) thickness = findThickness(context) || findThickness(out.material) || (gram ? { value: gram.value, kind: 'gauge' } : null);
  if (thickness && !thickness.kind) {
    const written = findThickness(`${context} ${message}`);
    thickness.kind = ['gauge', 'micron'].includes(out.thicknessKind) ? out.thicknessKind : written?.value === thickness.value ? written.kind : 'gauge';
  }
  out.thickness = thickness ? thickness.value : null;
  out.thicknessKind = thickness ? thickness.kind : '';
  if (gram && out.thickness === gram.value) out.product = out.product.replace(gram.token, ' ').replace(/\s+/g, ' ').trim();

  out.material = normalizeMaterial(out.material, [out.product, out.notes].join(' '));
  notes.push(...findFeatures([out.product, out.notes].join(' ')));
  out.notes = mergeNotes(out.notes, notes);
  return out;
}

// Size, flap and unit as the sales order stores them: inch values as plain
// numbers, mm / cm with the unit written (the weight formula converts them).
function orderSize(line) {
  const unit = sizeUnit(line.sizeUnit);
  return {
    width: text(line.width) ? withUnit(text(line.width), unit) : '',
    length: text(line.length) ? withUnit(text(line.length), unit) : '',
    flap: text(line.flap) ? withUnit(text(line.flap), unit) : '',
    gusset: text(line.gusset) ? withUnit(text(line.gusset), unit) : '',
  };
}

// PO number written in the text: "po-7321", "PPO/A-12/27/98", "PO No: 4500123".
function findPoNumber(source) {
  const value = String(source || '');
  const token = value.match(/\b(P{1,2}O[/-][A-Z0-9][A-Z0-9/-]*[A-Z0-9])/i);
  if (token) return token[1];
  const named = value.match(/\b(?:P\.?O\.?|purchase order)\s*(?:no\.?|number|#)\s*[:-]?\s*([A-Z0-9][A-Z0-9/-]*[A-Z0-9])/i);
  return named ? named[1] : '';
}

// Job / style / SO numbers the customer quotes; kept as references in the notes.
function findReferences(source) {
  const value = String(source || '');
  const refs = [];
  const job = value.match(/\bjob\s*(?:no\.?|number|#)\s*[:-]?\s*([A-Z0-9][A-Z0-9/.-]*[A-Z0-9])/i);
  if (job) refs.push(`Job No ${job[1]}`);
  const style = value.match(/\bstyle\s*(?:no\.?|number|#)\s*[:-]?\s*([A-Z0-9][\w/-]*)/i);
  if (style) refs.push(`Style no ${style[1]}`);
  const so = value.match(/\bS\.?O\.?\s*(?:no\.?|number|#)\s*[:-]?\s*([A-Z0-9][A-Z0-9/-]*[A-Z0-9])/i);
  if (so) refs.push(`SO No ${so[1]}`);
  return refs;
}

// "Delivery Date : 24-Oct-2026" → 2026-10-24; a day without a year, or
// "today", is kept as a note instead.
function findDelivery(source) {
  const value = String(source || '');
  const full = value.match(/\b(?:delivery\s*date|delivery\s*by|needed\s*by|required\s*by|deliver\s*by)\s*[:-]?\s*(\d{1,2})[\s/.-]([a-z]{3,9}|\d{1,2})[\s/.-](\d{4}|\d{2})\b/i);
  if (full) {
    const month = /^\d+$/.test(full[2]) ? Number(full[2]) : MONTHS.indexOf(full[2].slice(0, 3).toLowerCase()) + 1;
    const year = full[3].length === 2 ? `20${full[3]}` : full[3];
    const day = Number(full[1]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, note: '' };
    }
  }
  const loose = value.match(/[^\n]*\b(?:needed|required|delivery|deliver)\b[^\n]*\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2})\b[^\n]*/i);
  return loose ? { date: '', note: `Delivery: ${loose[0].trim().slice(0, 80)}` } : null;
}

// Payment / logistics follow-ups and empty mails are not orders. Only when
// nothing in the message or the reading has a product with a quantity.
function notOrderReason({ body = '', subject = '', fileCount = 0, lines = [] }) {
  const message = String(body || '').trim();
  if (!message && !fileCount) return 'The message is empty and has no attachment.';
  if (fileCount && /\b(?:pfa|attached|attachment|enclosed)\b/i.test(message)) return '';
  const hasLine = (lines || []).some((line) => text(line.product) && Number(line.quantity) > 0);
  if (hasLine || findQuantity(`${subject}\n${message}`, { strict: true })) return '';
  if (FOLLOW_UP.test(message)) return 'This looks like a payment or delivery follow-up, not a new order.';
  return '';
}

const NEW_ORDER = /\b(?:create|make|book|raise|punch|place|take)\s+(?:a\s+|one\s+|another\s+)?(?:new\s+)?(?:sales\s+)?order\s+(?:of|for)\b|\b(?:new|another|next|second)\s+order\b/i;
const CORRECTION = /\b(?:make it|instead|change|update|revise|correction|same order|same one|in (?:the )?same|add (?:to|in)|also add)\b/i;

// WhatsApp: does this message start a different order in a chat whose draft
// was already read and has lines? Conservative on purpose: only an explicit
// "create a sales order of …" / "new order", or a complete new line (product,
// a size not on the draft, and a quantity with its unit) that is not worded
// as a change. Everything else ("make it 5000", a PO photo) joins the draft.
function startsNewOrder(open, body) {
  const lines = open?.proposal?.lines || [];
  if (!lines.length || !['needs_review', 'customer_confirmed'].includes(open.status)) return false;
  const message = String(body || '').trim();
  if (!message) return false;
  if (NEW_ORDER.test(message)) return true;
  if (CORRECTION.test(message) || !PRODUCT_WORD.test(message)) return false;
  const size = parseSize(message);
  if (!size || !findQuantity(message, { strict: true })) return false;
  const known = lines.some((line) => Number(line.width) === Number(size.width) && Number(line.length) === Number(size.length));
  return !known;
}

module.exports = {
  SIZE_PATTERN,
  SIZE_PATTERN_ALL,
  parseSize,
  parseQuantity,
  findQuantity,
  normalizeUnit,
  normalizeMaterial,
  findThickness,
  findFeatures,
  mergeNotes,
  cleanLine,
  orderSize,
  findPoNumber,
  findReferences,
  findDelivery,
  notOrderReason,
  startsNewOrder,
  sizeUnit,
};
