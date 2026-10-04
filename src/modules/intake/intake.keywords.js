const DEFAULT_ORDER_KEYWORDS = [
  'order',
  'purchase order',
  'proforma',
  'quotation',
  'quote',
  'enquiry',
  'inquiry',
  'requirement',
  'pi',
  'po',
  'bag',
  'roll',
  'pouch',
  'pcs',
  'pieces',
  'kg',
  'quantity',
  'qty',
  'rate',
  'delivery',
  'gst',
  'micron',
  'ldpe',
  'hdpe',
  'bopp',
  'polly',
  'poly',
];

function parseKeywords(value) {
  const list = String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_ORDER_KEYWORDS.slice();
}

function findKeywords(text, keywords) {
  const found = [];
  const source = String(text || '');
  for (const word of keywords) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    if (pattern.test(source) && !found.some((item) => item.toLowerCase() === word.toLowerCase())) {
      found.push(word);
    }
  }
  return found;
}

module.exports = {
  DEFAULT_ORDER_KEYWORDS,
  parseKeywords,
  findKeywords,
};
