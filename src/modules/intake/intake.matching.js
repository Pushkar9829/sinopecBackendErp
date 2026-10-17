const Customer = require('../customer/customer.model');
const ProductTemplate = require('../salesSettings/template.model');
const { normalizeGst, normalizePhone, parseAddress } = require('./intake.text');

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function summary(customer, matchedBy) {
  return {
    id: String(customer._id),
    code: customer.code,
    name: customer.name,
    companyName: customer.companyName || '',
    mobile: customer.mobile || '',
    email: customer.email || '',
    gstNumber: customer.gstNumber || '',
    isActive: customer.isActive !== false,
    matchedBy,
  };
}

// Strongest proof first: GST number, then mobile, then email, then name.
// Returns { best, by, candidates }; `best` is set only for GST/mobile/email.
async function matchCustomer(proposal, sender = {}) {
  const customer = proposal?.customer || {};
  const found = new Map();
  const add = (rows, by) => {
    for (const row of rows) if (!found.has(String(row._id))) found.set(String(row._id), summary(row, by));
  };
  const fields = 'code name companyName mobile email gstNumber isActive';

  const gst = normalizeGst(customer.gstNumber);
  if (gst.length === 15) {
    add(await Customer.find({ gstNumber: new RegExp(`^\\s*${escapeRegex(gst)}\\s*$`, 'i') }).select(fields).limit(5).lean(), 'gst');
  }
  const phones = [...new Set([customer.mobile, sender.phone].map(normalizePhone).filter((p) => p.length === 10))];
  for (const phone of phones) {
    // Stored numbers may carry +91, spaces or dashes; match on the last ten digits.
    const loose = phone.split('').join('[^0-9]*');
    add(await Customer.find({ mobile: new RegExp(`${loose}\\s*$`) }).select(fields).limit(5).lean(), 'mobile');
  }
  const emails = [...new Set([customer.email, sender.email].map((e) => parseAddress(e).email).filter(Boolean))];
  for (const email of emails) {
    add(await Customer.find({ email: new RegExp(`^\\s*${escapeRegex(email)}\\s*$`, 'i') }).select(fields).limit(5).lean(), 'email');
  }
  const names = [...new Set([customer.companyName, customer.name].map((n) => String(n || '').trim()).filter((n) => n.length >= 3))];
  for (const name of names) {
    const pattern = new RegExp(escapeRegex(name), 'i');
    add(await Customer.find({ $or: [{ name: pattern }, { companyName: pattern }] }).select(fields).limit(5).lean(), 'name');
  }

  const candidates = [...found.values()].slice(0, 8);
  const strong = candidates.find((c) => c.matchedBy !== 'name' && c.isActive);
  return { best: strong ? strong.id : null, by: strong ? strong.matchedBy : '', candidates };
}

function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}

function score(lineText, candidateText) {
  const wanted = words(lineText);
  if (!wanted.length) return 0;
  const have = new Set(words(candidateText));
  return wanted.filter((w) => have.has(w)).length / wanted.length;
}

function specOf(source, item, label, strong) {
  return {
    source,
    // Close enough to pick by default; weaker ones are only offered.
    strong,
    id: String(item._id),
    label,
    product: item.product || item.name || '',
    productCode: item.productCode || item.code || '',
    productionRoute: item.productionRoute,
    size: item.size || '',
    material: item.material || '',
    width: item.width || '',
    length: item.length || '',
    unit: item.unit || 'pcs',
    rate: source === 'customer' ? Number(item.rate) || 0 : 0,
  };
}

// Up to three saved products per line: the customer's own first, then shared templates.
async function suggestProducts(customerId, lines) {
  const customer = customerId ? await Customer.findById(customerId).select('products').lean() : null;
  const own = customer?.products || [];
  const templates = await ProductTemplate.find({ isActive: { $ne: false } })
    .select('name code product productCode productionRoute size material width length unit')
    .limit(1000)
    .lean();
  return (lines || []).map((line) => {
    const text = [line.product, line.material, line.width && line.length ? `${line.width}x${line.length}` : ''].join(' ');
    const ranked = [
      ...own.map((p) => {
        const s = score(text, `${p.product} ${p.productCode} ${p.material} ${p.size}`);
        return { s: s + 0.25, spec: specOf('customer', p, `${p.product}${p.size ? ` ${p.size}` : ''} (this customer)`, s >= 0.75) };
      }),
      ...templates.map((t) => {
        const s = score(text, `${t.name} ${t.product} ${t.code} ${t.material} ${t.size}`);
        return { s, spec: specOf('template', t, `${t.name}${t.size ? ` ${t.size}` : ''}`, s >= 0.75) };
      }),
    ]
      .filter((entry) => entry.s > 0.3)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);
    return ranked.map((entry) => entry.spec);
  });
}

module.exports = { matchCustomer, suggestProducts };
