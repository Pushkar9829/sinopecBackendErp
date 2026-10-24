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
    otherProcess: item.otherProcess || '',
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
    .select('name code product productCode productionRoute otherProcess size material width length unit')
    .limit(1000)
    .lean();
  return (lines || []).map((line) => {
    const text = lineText(line);
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

function lineText(line) {
  return [line?.product, line?.material, line?.width && line?.length ? `${line.width}x${line.length}` : ''].join(' ');
}

// Every word of the search must appear somewhere in the product.
function matchesSearch(q, text) {
  const wanted = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const have = String(text || '').toLowerCase();
  return wanted.every((w) => have.includes(w));
}

const PICKER_LIMIT = 50;

// The product picker: all of the customer's products and all active saved
// products, best matches for the draft line first, then by name. `q` narrows
// both groups; each group is cut at `limit` and says how many there are.
async function listProducts(customerId, { q = '', line = null, limit = PICKER_LIMIT } = {}) {
  const max = Math.min(200, Math.max(1, Number(limit) || PICKER_LIMIT));
  const search = String(q || '').trim().slice(0, 80);
  const text = line ? lineText(line) : '';
  const customer = customerId ? await Customer.findById(customerId).select('products').lean() : null;
  const templateFilter = { isActive: { $ne: false } };
  if (search) {
    const pattern = new RegExp(search.split(/\s+/).map(escapeRegex).join('|'), 'i');
    templateFilter.$or = ['name', 'code', 'product', 'productCode', 'material', 'size'].map((field) => ({ [field]: pattern }));
  }
  const templates = await ProductTemplate.find(templateFilter)
    .select('name code product productCode productionRoute otherProcess size material width length unit')
    .limit(2000)
    .lean();

  const rank = (rows) =>
    rows
      .sort((a, b) => b.s - a.s || a.spec.label.localeCompare(b.spec.label))
      .map((entry) => entry.spec);
  const own = rank(
    (customer?.products || [])
      .map((p) => {
        const haystack = `${p.product} ${p.productCode} ${p.material} ${p.size}`;
        const s = text ? score(text, haystack) : 0;
        return { s, haystack, spec: specOf('customer', p, `${p.product}${p.size ? ` ${p.size}` : ''}`, s >= 0.75) };
      })
      .filter((entry) => !search || matchesSearch(search, entry.haystack))
  );
  const saved = rank(
    templates
      .map((t) => {
        const haystack = `${t.name} ${t.product} ${t.code} ${t.productCode} ${t.material} ${t.size}`;
        const s = text ? score(text, haystack) : 0;
        return { s, haystack, spec: specOf('template', t, `${t.name}${t.size ? ` ${t.size}` : ''}`, s >= 0.75) };
      })
      .filter((entry) => !search || matchesSearch(search, entry.haystack))
  );
  return {
    customer: { items: own.slice(0, max), total: own.length },
    saved: { items: saved.slice(0, max), total: saved.length },
  };
}

// The "find another customer" box on a draft: name, company, code, mobile,
// email or GST number. Active customers first.
async function searchCustomers(q, limit = 20) {
  const text = String(q || '').trim().slice(0, 80);
  if (text.length < 2) return [];
  const pattern = new RegExp(escapeRegex(text), 'i');
  const or = ['name', 'companyName', 'code', 'mobile', 'email', 'gstNumber'].map((field) => ({ [field]: pattern }));
  const phone = normalizePhone(text);
  if (phone.length >= 6 && phone.length <= 10) or.push({ mobile: new RegExp(phone.split('').join('[^0-9]*')) });
  const rows = await Customer.find({ $or: or })
    .select('code name companyName mobile email gstNumber isActive')
    .sort({ isActive: -1, name: 1 })
    .limit(Math.min(50, Math.max(1, Number(limit) || 20)))
    .lean();
  return rows.map((row) => summary(row, 'search'));
}

// A customer that already has this GST number or mobile, so creating one from
// a draft (or retrying after an error) never makes a duplicate.
async function findExistingCustomer({ gstNumber, mobile } = {}) {
  const gst = normalizeGst(gstNumber);
  if (gst.length === 15) {
    const byGst = await Customer.findOne({ gstNumber: new RegExp(`^\\s*${escapeRegex(gst)}\\s*$`, 'i') }).select('_id').lean();
    if (byGst) return String(byGst._id);
  }
  const phone = normalizePhone(mobile);
  if (phone.length === 10) {
    const loose = phone.split('').join('[^0-9]*');
    const byMobile = await Customer.findOne({ mobile: new RegExp(`${loose}\\s*$`) }).select('_id').lean();
    if (byMobile) return String(byMobile._id);
  }
  return null;
}

module.exports = { matchCustomer, suggestProducts, listProducts, searchCustomers, findExistingCustomer };
