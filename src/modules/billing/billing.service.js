const mongoose = require('mongoose');
const { PAYMENT_METHODS, SALES_ORDER_STATUSES } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { nextSeq } = require('../../utils/counter');
const { endOfBusinessDay, businessYmd } = require('../../utils/businessTime');
const { hasPermission, isSuperAdmin } = require('../../utils/permissions');
const { inTransaction } = require('../../utils/transaction');
const Customer = require('../customer/customer.model');
const SalesOrder = require('../salesOrder/salesOrder.model');
const companyService = require('../company/company.service');
const { stageStats } = require('../production/production.flow');
const Invoice = require('./invoice.model');
const Receipt = require('./receipt.model');

const DAY = 24 * 60 * 60 * 1000;
const EPS = 0.005;
// Orders that can be invoiced: approved onwards, not cancelled.
const NOT_INVOICEABLE = [SALES_ORDER_STATUSES.DRAFT, SALES_ORDER_STATUSES.SUBMITTED, SALES_ORDER_STATUSES.CANCELLED];

const money = (value) => {
  const n = Number(value) || 0;
  return Math.round((n + Math.sign(n) * Number.EPSILON) * 100) / 100;
};
const str = (value) => (value === undefined || value === null ? '' : String(value).trim());
const METHOD_LABEL = { bank_transfer: 'Bank transfer', upi: 'UPI', cheque: 'Cheque', cash: 'Cash', other: 'Other' };
const methodLabel = (method) => METHOD_LABEL[method] || method || '';
const actor = (user) => user?.fullName || user?.username || '';

// ---------------------------------------------------------------- access

function canView(user) {
  return isSuperAdmin(user) || hasPermission(user, 'accounts:read') || hasPermission(user, 'sales:read');
}
function canInvoice(user) {
  return isSuperAdmin(user) || hasPermission(user, 'accounts:create') || hasPermission(user, 'sales:update');
}
function canReceive(user) {
  return isSuperAdmin(user) || hasPermission(user, 'accounts:create') || hasPermission(user, 'accounts:update') || hasPermission(user, 'sales:update');
}
function canCorrect(user) {
  return isSuperAdmin(user) || hasPermission(user, 'accounts:update');
}
function assert(allowed, message) {
  if (!allowed) throw new ApiError(403, message);
}

// ---------------------------------------------------------------- helpers

function parseDay(value, label, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, `${label} is required`);
    return null;
  }
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T12:00:00+05:30` : value);
  if (Number.isNaN(date.getTime())) throw new ApiError(400, `${label} is not a valid date`);
  return date;
}

function dueFrom(date, creditDays) {
  return endOfBusinessDay(new Date(date.getTime() + Math.max(0, Number(creditDays) || 0) * DAY));
}

// Indian financial year (April-March) of a date, e.g. "26-27".
function financialYear(date) {
  const ymd = businessYmd(date);
  const year = Number(ymd.slice(0, 4));
  const start = Number(ymd.slice(5, 7)) >= 4 ? year : year - 1;
  return `${String(start).slice(2)}-${String(start + 1).slice(2)}`;
}

async function loadCustomer(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Customer not found');
  const customer = await Customer.findById(id).select('-products');
  if (!customer) throw new ApiError(404, 'Customer not found');
  return customer;
}

function buyerOf(customer, order) {
  const gstin = str(order?.customerSnapshot?.gstNumber || customer.gstNumber).toUpperCase();
  return {
    code: customer.code,
    name: customer.name,
    companyName: customer.companyName || '',
    gstin,
    stateCode: /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : '',
    address: str(order?.billingAddress || customer.billingAddress),
    shippingAddress: str(order?.shippingAddress || customer.shippingAddress),
    mobile: customer.mobile || '',
    email: customer.email || '',
  };
}

// Credit orders use their own credit days; advance and cash-on-delivery are due at once.
function creditDaysOf(customer, company, order) {
  if (order && ['advance', 'cod'].includes(order.paymentTerms)) return 0;
  if (order && Number.isFinite(Number(order.creditDays))) return Number(order.creditDays);
  if (customer.creditDays !== null && customer.creditDays !== undefined) return customer.creditDays;
  return company.defaultCreditDays ?? 30;
}

// ---------------------------------------------------------------- invoicing

async function invoicedByItem(orderId) {
  const rows = await Invoice.find({ salesOrder: orderId, status: 'issued', kind: 'sale' }).select('lines').lean();
  const totals = new Map();
  for (const invoice of rows) {
    for (const line of invoice.lines) totals.set(String(line.itemId), (totals.get(String(line.itemId)) || 0) + line.quantity);
  }
  return totals;
}

async function loadOrder(orderId) {
  if (!mongoose.isValidObjectId(orderId)) throw new ApiError(404, 'Order not found');
  const order = await SalesOrder.findById(orderId);
  if (!order) throw new ApiError(404, 'Order not found');
  return order;
}

// What can still be billed on an order, line by line.
async function invoiceDraft(user, orderId) {
  assert(canView(user), 'You cannot see invoices');
  const order = await loadOrder(orderId);
  const [customer, company, invoiced] = await Promise.all([loadCustomer(order.customer), companyService.getSettings(), invoicedByItem(order._id)]);
  const buyer = buyerOf(customer, order);
  const intraState = !buyer.stateCode || !company.stateCode || buyer.stateCode === company.stateCode;
  const lines = (order.items || []).map((item) => {
    const dispatched = stageStats(item, 'dispatch').output || 0;
    const done = invoiced.get(String(item._id)) || 0;
    return {
      itemId: String(item._id),
      product: item.product,
      productCode: item.productCode || '',
      hsnCode: item.hsnCode || company.defaultHsnCode || '',
      unit: item.unit || 'pcs',
      ordered: item.quantity,
      dispatched: money(dispatched),
      invoiced: money(done),
      available: money(Math.max(0, item.quantity - done)),
      suggested: money(Math.max(0, Math.min(item.quantity, dispatched) - done)),
      rate: item.rate,
      gstPercent: item.taxPercent || 0,
    };
  });
  return {
    order: { id: String(order._id), number: order.number, status: order.status, orderType: order.orderType },
    canInvoice: !NOT_INVOICEABLE.includes(order.status),
    buyer,
    seller: company,
    intraState,
    creditDays: creditDaysOf(customer, company, order),
    lines,
  };
}

// Line value after the line discount and its share of the order discount,
// both taken in proportion to the quantity billed now.
function priceLine(item, quantity, orderDiscountShare, intraState, gstPercent) {
  const ordered = Number(item.quantity) || 0;
  const fraction = ordered > 0 ? quantity / ordered : 0;
  const gross = quantity * (Number(item.rate) || 0);
  const discount = money(((Number(item.discount) || 0) + orderDiscountShare) * fraction);
  const taxable = money(Math.max(0, gross - discount));
  const tax = (taxable * gstPercent) / 100;
  const cgst = intraState ? money(tax / 2) : 0;
  const sgst = intraState ? money(tax / 2) : 0;
  const igst = intraState ? 0 : money(tax);
  return { taxable, discount, cgst, sgst, igst, amount: money(taxable + cgst + sgst + igst) };
}

async function createInvoice(user, orderId, payload = {}) {
  assert(canInvoice(user), 'You cannot make invoices');
  const order = await loadOrder(orderId);
  if (NOT_INVOICEABLE.includes(order.status)) throw new ApiError(400, 'An order can be invoiced once it is approved, and not after it is cancelled');
  const [customer, company] = await Promise.all([loadCustomer(order.customer), companyService.getSettings()]);
  if (!company.gstin) throw new ApiError(400, 'Add your GSTIN in Company details before making invoices');
  const invoiceDate = parseDay(payload.invoiceDate || new Date(), 'Invoice date');
  if (invoiceDate.getTime() > Date.now() + DAY) throw new ApiError(400, 'Invoice date cannot be in the future');
  const buyer = buyerOf(customer, order);
  const intraState = !buyer.stateCode || buyer.stateCode === company.stateCode;
  const wanted = new Map((Array.isArray(payload.lines) ? payload.lines : []).map((line) => [String(line.itemId), Number(line.quantity) || 0]));

  // Order discount spread over lines by value, as on the order itself.
  const items = order.items || [];
  const lineValues = items.map((item) => Math.max(0, item.quantity * item.rate - (item.discount || 0)));
  const subtotal = lineValues.reduce((sum, value) => sum + value, 0);
  const orderDiscount = Math.min(Math.max(0, Number(order.discount) || 0), subtotal);

  // One transaction (when MongoDB supports it): two people billing the same
  // dispatch at once can't both take the last quantity.
  return inTransaction(async () => {
    const invoiced = await invoicedByItem(order._id);
    const lines = [];
    items.forEach((item, index) => {
      const quantity = wanted.get(String(item._id)) || 0;
      if (quantity <= 0) return;
      const left = item.quantity - (invoiced.get(String(item._id)) || 0);
      if (quantity > left + 1e-6) throw new ApiError(400, `${item.product || `Line ${index + 1}`}: only ${money(left)} ${item.unit} left to invoice`);
      const gstPercent = Number(item.taxPercent) || 0;
      const share = subtotal > 0 ? (orderDiscount * lineValues[index]) / subtotal : 0;
      lines.push({
        itemId: item._id,
        product: item.product,
        productCode: item.productCode || '',
        hsnCode: item.hsnCode || company.defaultHsnCode || '',
        quantity,
        unit: item.unit || 'pcs',
        rate: item.rate,
        gstPercent,
        ...priceLine(item, quantity, share, intraState, gstPercent),
      });
    });
    if (!lines.length) throw new ApiError(400, 'Enter a quantity on at least one line');

    const sum = (key) => money(lines.reduce((total, line) => total + line[key], 0));
    const exact = sum('taxable') + sum('cgst') + sum('sgst') + sum('igst');
    const total = Math.round(exact);
    const creditDays = payload.creditDays !== undefined && payload.creditDays !== '' ? Math.max(0, Math.round(Number(payload.creditDays) || 0)) : creditDaysOf(customer, company, order);
    const fy = financialYear(invoiceDate);
    const prefix = company.invoicePrefix || 'INV';
    // Never reuse a number: if the counter was ever reset, skip numbers already taken.
    let number;
    for (let tries = 0; tries < 1000; tries += 1) {
      number = `${prefix}/${fy}/${String(await nextSeq(`invoice:${fy}`)).padStart(4, '0')}`;
      if (!(await Invoice.exists({ kind: 'sale', number }))) break;
    }
    const [doc] = await Invoice.create(
      [
        {
          kind: 'sale',
          number,
          financialYear: fy,
          customer: customer._id,
          buyer,
          seller: company,
          salesOrder: order._id,
          orderNumber: order.number,
          orderType: order.orderType,
          invoiceDate,
          creditDays,
          dueDate: dueFrom(invoiceDate, creditDays),
          intraState,
          placeOfSupply: buyer.stateCode || company.stateCode,
          lines,
          taxable: sum('taxable'),
          cgst: sum('cgst'),
          sgst: sum('sgst'),
          igst: sum('igst'),
          roundOff: money(total - exact),
          total,
          notes: str(payload.notes),
          createdBy: user._id,
          createdByName: actor(user),
        },
      ]
    );
    return doc.toJSON();
  });
}

async function cancelInvoice(user, id, reason) {
  assert(canCorrect(user), 'Only Accounts or the Super Admin can cancel invoices');
  const why = str(reason);
  if (!why) throw new ApiError(400, 'Give a reason for cancelling');
  const updated = await Invoice.findOneAndUpdate(
    { _id: id, status: 'issued' },
    { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledByName: actor(user), cancelReason: why } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'This invoice is already cancelled or does not exist');
  return updated.toJSON();
}

async function getInvoice(user, id) {
  assert(canView(user), 'You cannot see invoices');
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Invoice not found');
  const invoice = await Invoice.findById(id);
  if (!invoice) throw new ApiError(404, 'Invoice not found');
  const account = await customerAccount(invoice.customer);
  const state = account.invoices.find((row) => row.id === String(invoice._id));
  return { ...invoice.toJSON(), paid: state?.paid || 0, balance: state?.balance ?? invoice.total, payState: state?.payState || 'unpaid' };
}

async function listInvoices(user, { orderId, customerId } = {}) {
  assert(canView(user), 'You cannot see invoices');
  const filter = {};
  if (orderId) filter.salesOrder = orderId;
  if (customerId) filter.customer = customerId;
  const rows = await Invoice.find(filter).select('-lines -seller').sort({ invoiceDate: -1, createdAt: -1 }).limit(500);
  return rows.map((row) => row.toJSON());
}

// ---------------------------------------------------------------- opening bills

async function addOpeningBill(user, customerId, payload = {}) {
  assert(canCorrect(user) || hasPermission(user, 'accounts:create'), 'Only Accounts or the Super Admin can enter opening balances');
  const customer = await loadCustomer(customerId);
  const number = str(payload.number);
  if (!number) throw new ApiError(400, 'Bill number is required');
  const total = money(payload.amount);
  if (!(total > 0)) throw new ApiError(400, 'Amount must be more than 0');
  const invoiceDate = parseDay(payload.date, 'Bill date');
  const company = await companyService.getSettings();
  const creditDays = creditDaysOf(customer, company, null);
  const dueDate = payload.dueDate ? endOfBusinessDay(parseDay(payload.dueDate, 'Due date')) : dueFrom(invoiceDate, creditDays);
  try {
    const doc = await Invoice.create({
      kind: 'opening',
      number,
      customer: customer._id,
      buyer: buyerOf(customer, null),
      invoiceDate,
      creditDays,
      dueDate,
      total,
      notes: str(payload.notes) || 'Opening balance',
      createdBy: user._id,
      createdByName: actor(user),
    });
    return doc.toJSON();
  } catch (error) {
    if (error?.code === 11000) throw new ApiError(409, `Bill ${number} is already entered for this customer`);
    throw error;
  }
}

// rows: [{ customer: code | GSTIN | exact name, number, date, amount, dueDate? }]
async function importOpeningBills(user, rows = [], apply = false) {
  assert(canCorrect(user) || hasPermission(user, 'accounts:create'), 'Only Accounts or the Super Admin can enter opening balances');
  if (!Array.isArray(rows) || !rows.length) throw new ApiError(400, 'The file has no rows');
  if (rows.length > 5000) throw new ApiError(400, 'Up to 5000 rows at a time');
  const customers = await Customer.find({}).select('code name companyName gstNumber').lean();
  const byKey = new Map();
  for (const c of customers) {
    for (const key of [c.code, c.gstNumber, c.name, c.companyName]) if (key) byKey.set(String(key).trim().toLowerCase(), c);
  }
  const report = rows.map((row, index) => {
    const line = index + 2;
    const customer = byKey.get(str(row.customer).toLowerCase());
    const problems = [];
    if (!customer) problems.push(`customer "${str(row.customer)}" not found`);
    if (!str(row.number)) problems.push('bill number missing');
    if (!(money(row.amount) > 0)) problems.push('amount must be more than 0');
    try {
      parseDay(row.date, 'Bill date');
      if (row.dueDate) parseDay(row.dueDate, 'Due date');
    } catch (error) {
      problems.push(error.message.toLowerCase());
    }
    return { line, customer: customer ? `${customer.code} ${customer.name}` : str(row.customer), customerId: customer ? String(customer._id) : '', number: str(row.number), amount: money(row.amount), date: str(row.date), dueDate: str(row.dueDate), problems };
  });
  const bad = report.filter((row) => row.problems.length);
  if (!apply || bad.length) return { applied: false, rows: report, errors: bad.length, total: money(report.reduce((s, r) => s + r.amount, 0)) };
  let added = 0;
  const skipped = [];
  for (const row of report) {
    try {
      await addOpeningBill(user, row.customerId, { number: row.number, date: row.date, amount: row.amount, dueDate: row.dueDate || undefined });
      added += 1;
    } catch (error) {
      skipped.push({ line: row.line, reason: error.message });
    }
  }
  return { applied: true, added, skipped, rows: report };
}

// ---------------------------------------------------------------- receipts

async function addReceipt(user, customerId, payload = {}) {
  assert(canReceive(user), 'You cannot record payments');
  const customer = await loadCustomer(customerId);
  const amount = money(payload.amount);
  if (!(amount > 0)) throw new ApiError(400, 'Amount must be more than 0');
  const receivedAt = parseDay(payload.receivedAt || new Date(), 'Received date');
  if (receivedAt.getTime() > Date.now() + DAY) throw new ApiError(400, 'Received date cannot be in the future');
  const method = str(payload.method) || PAYMENT_METHODS.BANK_TRANSFER;
  if (!Object.values(PAYMENT_METHODS).includes(method)) throw new ApiError(400, 'Invalid payment method');
  let invoice = null;
  if (payload.invoiceId) {
    invoice = await Invoice.findOne({ _id: payload.invoiceId, customer: customer._id, status: 'issued' });
    if (!invoice) throw new ApiError(400, 'That bill is not an open bill of this customer');
  }
  const year = new Date().getFullYear();
  let number;
  for (let tries = 0; tries < 1000; tries += 1) {
    number = `RCPT-${year}-${String(await nextSeq(`receipt:${year}`)).padStart(5, '0')}`;
    if (!(await Receipt.exists({ number }))) break;
  }
  const doc = await Receipt.create({
    number,
    customer: customer._id,
    invoice: invoice?._id || null,
    receivedAt,
    amount,
    method,
    reference: str(payload.reference),
    note: str(payload.note),
    createdBy: user._id,
    createdByName: actor(user),
  });
  return doc.toJSON();
}

async function voidReceipt(user, id, reason) {
  assert(canCorrect(user), 'Only Accounts or the Super Admin can void payments');
  const why = str(reason);
  if (!why) throw new ApiError(400, 'Give a reason for voiding');
  const updated = await Receipt.findOneAndUpdate(
    { _id: id, voidedAt: null },
    { $set: { voidedAt: new Date(), voidedByName: actor(user), voidReason: why } },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'This payment is already voided or does not exist');
  return updated.toJSON();
}

// ---------------------------------------------------------------- the account

// Everything a customer owes and has paid, matched the same way every time:
// 1) a payment made for one bill goes to that bill; 2) money recorded on an
// order (advance, order payments) goes only to that order's invoices, and
// what is left waits as an advance for that order; 3) other payments pay the
// bills that fell due first. Nothing is stored, so voids and cancellations can
// never leave a stale balance behind.
async function customerAccount(customerId, { asOf = new Date() } = {}) {
  const [invoices, receipts, orders] = await Promise.all([
    Invoice.find({ customer: customerId, status: 'issued' }).select('-lines -seller -buyer').sort({ dueDate: 1, invoiceDate: 1, _id: 1 }).lean(),
    Receipt.find({ customer: customerId, voidedAt: null }).sort({ receivedAt: 1, _id: 1 }).lean(),
    SalesOrder.find({ customer: customerId, status: { $ne: SALES_ORDER_STATUSES.CANCELLED } }).select('number orderDate advanceAmount payments').lean(),
  ]);
  const state = invoices.map((inv) => ({ ...inv, paid: 0 }));
  const balanceOf = (row) => money(row.total - row.paid);
  const apply = (rows, amount) => {
    let left = amount;
    for (const row of rows) {
      if (left <= EPS) break;
      const take = Math.min(left, balanceOf(row));
      if (take > 0) {
        row.paid = money(row.paid + take);
        left = money(left - take);
      }
    }
    return left;
  };

  const credits = [];
  let pool = 0;
  let orderAdvance = 0;
  for (const receipt of receipts) {
    credits.push({ date: receipt.receivedAt, type: 'receipt', ref: receipt.number, detail: [methodLabel(receipt.method), receipt.reference].filter(Boolean).join(' · '), amount: receipt.amount, id: String(receipt._id) });
    const target = receipt.invoice ? state.filter((row) => String(row._id) === String(receipt.invoice)) : [];
    pool = money(pool + apply(target, receipt.amount));
  }
  for (const order of orders) {
    const paid = money((Number(order.advanceAmount) || 0) + (order.payments || []).filter((p) => !p.voidedAt).reduce((s, p) => s + p.amount, 0));
    if (Number(order.advanceAmount) > 0) credits.push({ date: order.orderDate, type: 'advance', ref: order.number, detail: 'Advance entered on the order', amount: money(order.advanceAmount), orderId: String(order._id) });
    for (const p of (order.payments || []).filter((x) => !x.voidedAt)) {
      credits.push({ date: p.receivedAt, type: 'order_payment', ref: order.number, detail: [methodLabel(p.method), p.reference].filter(Boolean).join(' · '), amount: p.amount, orderId: String(order._id) });
    }
    if (paid > 0) {
      const own = state.filter((row) => String(row.salesOrder || '') === String(order._id));
      orderAdvance = money(orderAdvance + apply(own, paid));
    }
  }
  const unapplied = apply(state, pool);

  const now = asOf.getTime();
  const rows = state.map((row) => {
    const balance = balanceOf(row);
    const overdueDays = balance > EPS && new Date(row.dueDate).getTime() < now ? Math.floor((now - new Date(row.dueDate).getTime()) / DAY) : 0;
    return {
      id: String(row._id),
      kind: row.kind,
      number: row.number,
      orderNumber: row.orderNumber || '',
      salesOrder: row.salesOrder ? String(row.salesOrder) : null,
      invoiceDate: row.invoiceDate,
      dueDate: row.dueDate,
      total: row.total,
      paid: row.paid,
      balance,
      overdueDays,
      payState: balance <= EPS ? 'paid' : row.paid > EPS ? 'partly_paid' : 'unpaid',
    };
  });
  const sum = (list, key) => money(list.reduce((s, r) => s + r[key], 0));
  const open = rows.filter((r) => r.balance > EPS);
  const ageing = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  for (const r of open) {
    const bucket = r.overdueDays === 0 ? 'current' : r.overdueDays <= 30 ? 'd1_30' : r.overdueDays <= 60 ? 'd31_60' : r.overdueDays <= 90 ? 'd61_90' : 'd90plus';
    ageing[bucket] = money(ageing[bucket] + r.balance);
  }
  return {
    invoices: rows,
    credits: credits.sort((a, b) => new Date(a.date) - new Date(b.date)),
    summary: {
      billed: sum(rows, 'total'),
      received: money(credits.reduce((s, c) => s + c.amount, 0)),
      outstanding: sum(open, 'balance'),
      overdue: money(open.filter((r) => r.overdueDays > 0).reduce((s, r) => s + r.balance, 0)),
      // Paid but not yet used: on-account money plus advances on orders not billed yet.
      advance: money(unapplied + orderAdvance),
      oldestOverdueDays: open.reduce((m, r) => Math.max(m, r.overdueDays), 0),
      ageing,
    },
  };
}

async function ledger(user, customerId) {
  assert(canView(user), 'You cannot see customer accounts');
  const customer = await loadCustomer(customerId);
  const account = await customerAccount(customer._id);
  const debits = account.invoices.map((inv) => ({
    date: inv.invoiceDate,
    type: inv.kind === 'opening' ? 'opening' : 'invoice',
    ref: inv.number,
    detail: inv.kind === 'opening' ? 'Opening balance' : `Order ${inv.orderNumber}`,
    debit: inv.total,
    credit: 0,
    id: inv.id,
  }));
  const entries = [...debits, ...account.credits.map((c) => ({ ...c, debit: 0, credit: c.amount }))].sort(
    (a, b) => new Date(a.date) - new Date(b.date) || b.debit - a.debit
  );
  let running = 0;
  for (const entry of entries) {
    running = money(running + entry.debit - entry.credit);
    entry.balance = running;
  }
  const limit = customer.creditLimit || 0;
  return {
    customer: { id: String(customer._id), code: customer.code, name: customer.name, companyName: customer.companyName || '', gstNumber: customer.gstNumber || '', creditDays: customer.creditDays, creditLimit: limit },
    summary: { ...account.summary, net: running, available: limit > 0 ? money(limit - account.summary.outstanding) : null },
    invoices: account.invoices,
    entries,
    receipts: (await Receipt.find({ customer: customer._id }).sort({ receivedAt: -1 }).limit(200)).map((r) => r.toJSON()),
  };
}


// ---------------------------------------------------------------- credit control

const OPEN_ORDER_STATUSES = ['submitted', 'approved', 'production_planned', 'in_production', 'ready_for_packing', 'packed', 'ready_for_dispatch', 'dispatched', 'delivered'];
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

// What the customer would owe if this order went ahead: unpaid bills, plus
// orders already accepted but not billed yet, plus this order, less money
// already paid in advance. "hold" when that passes the credit limit, or when
// a bill is more days late than the company allows.
async function creditCheck(customerId, { orderId = null, orderTotal = 0 } = {}) {
  const [customer, company, account] = await Promise.all([
    Customer.findById(customerId).select('creditLimit name').lean(),
    companyService.getSettings(),
    customerAccount(customerId),
  ]);
  const others = await SalesOrder.find({ customer: customerId, status: { $in: OPEN_ORDER_STATUSES }, ...(orderId ? { _id: { $ne: orderId } } : {}) })
    .select('grandTotal')
    .lean();
  const billedByOrder = new Map();
  const billed = await Invoice.aggregate([
    { $match: { customer: new mongoose.Types.ObjectId(String(customerId)), status: 'issued', kind: 'sale', salesOrder: { $ne: null } } },
    { $group: { _id: '$salesOrder', total: { $sum: '$total' } } },
  ]);
  for (const row of billed) billedByOrder.set(String(row._id), row.total);
  const billedThis = orderId ? billedByOrder.get(String(orderId)) || 0 : 0;
  const unbilled = money(others.reduce((sum, o) => sum + Math.max(0, (o.grandTotal || 0) - (billedByOrder.get(String(o._id)) || 0)), 0));
  const exposure = money(Math.max(0, account.summary.outstanding + unbilled + Math.max(0, orderTotal - billedThis) - account.summary.advance));
  const limit = customer?.creditLimit || 0;
  const holdDays = company.overdueHoldDays ?? 30;
  const reasons = [];
  if (limit > 0 && exposure > limit + EPS) reasons.push(`Owing would reach ${inr(exposure)} against a credit limit of ${inr(limit)}`);
  if (account.summary.oldestOverdueDays > holdDays) {
    reasons.push(`A bill is ${account.summary.oldestOverdueDays} days overdue (${inr(account.summary.overdue)} overdue in all)`);
  }
  return {
    status: reasons.length ? 'hold' : 'ok',
    reasons,
    exposure,
    limit,
    outstanding: account.summary.outstanding,
    overdue: account.summary.overdue,
    oldestOverdueDays: account.summary.oldestOverdueDays,
    unbilledOrders: unbilled,
    checkedAt: new Date(),
  };
}

// ---------------------------------------------------------------- receivables

async function receivables(user) {
  assert(canView(user), 'You cannot see customer accounts');
  const ids = new Set([
    ...(await Invoice.distinct('customer', { status: 'issued' })).map(String),
    ...(await Receipt.distinct('customer', { voidedAt: null })).map(String),
  ]);
  const customers = await Customer.find({ _id: { $in: [...ids] } }).select('code name companyName creditLimit creditDays mobile').lean();
  const rows = [];
  for (const c of customers) {
    const account = await customerAccount(c._id);
    rows.push({
      id: String(c._id),
      code: c.code,
      name: c.companyName || c.name,
      mobile: c.mobile || '',
      creditLimit: c.creditLimit || 0,
      creditDays: c.creditDays,
      ...account.summary,
      lastPaymentAt: account.credits.at(-1)?.date || null,
      openBills: account.invoices.filter((i) => i.balance > EPS).length,
    });
  }
  rows.sort((a, b) => b.overdue - a.overdue || b.outstanding - a.outstanding);
  const total = (key) => money(rows.reduce((s, r) => s + (r[key] || 0), 0));
  const ageing = {};
  for (const key of ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus']) ageing[key] = money(rows.reduce((s, r) => s + r.ageing[key], 0));
  return { rows, totals: { outstanding: total('outstanding'), overdue: total('overdue'), advance: total('advance'), ageing } };
}

// ---------------------------------------------------------------- overdue tasks

// One "collect overdue payment" task per customer with overdue bills, for
// Accounts. Kept up to date on each run; closes itself once nothing is overdue.
async function syncOverdueTasks() {
  const Task = require('../task/task.model');
  const { TASK_CATEGORIES, TASK_OPEN_STATUSES, TASK_STATUSES, ROLE_SLUGS } = require('../../config/constants');
  const { nextTaskNumber } = require('../../utils/counter');
  const customerIds = (await Invoice.distinct('customer', { status: 'issued', dueDate: { $lt: new Date() } })).map(String);
  const openTasks = await Task.find({ category: TASK_CATEGORIES.PAYMENT_OVERDUE, status: { $in: TASK_OPEN_STATUSES } });
  const byCustomer = new Map(openTasks.map((t) => [String(t.customer), t]));
  const stillOverdue = new Set();
  for (const id of customerIds) {
    const account = await customerAccount(id);
    if (!(account.summary.overdue > EPS)) continue;
    stillOverdue.add(id);
    const customer = await Customer.findById(id).select('name companyName').lean();
    const late = account.invoices.filter((i) => i.overdueDays > 0 && i.balance > EPS);
    const title = `Collect ${inr(account.summary.overdue)} overdue from ${customer?.companyName || customer?.name}`;
    const description = late.map((i) => `${i.number}: ${inr(i.balance)}, ${i.overdueDays} days late`).join('\n');
    const days = account.summary.oldestOverdueDays;
    const priority = days > 60 ? 'urgent' : days > 30 ? 'high' : 'normal';
    const existing = byCustomer.get(id);
    if (existing) {
      if (existing.title !== title || existing.description !== description || existing.priority !== priority) {
        existing.title = title;
        existing.description = description;
        existing.priority = priority;
        await existing.save();
      }
      continue;
    }
    const key = `overdue:${id}`;
    try {
      await Task.create({
        number: await nextTaskNumber(),
        title,
        description,
        category: TASK_CATEGORIES.PAYMENT_OVERDUE,
        source: 'auto',
        autoKey: key,
        openKey: key,
        customer: id,
        assigneeRole: ROLE_SLUGS.ACCOUNTS,
        priority,
        dueDate: endOfBusinessDay(new Date()),
        history: [{ from: '', to: TASK_STATUSES.OPEN, byName: 'System', note: 'Created automatically' }],
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
  }
  for (const task of openTasks) {
    if (stillOverdue.has(String(task.customer))) continue;
    task.history.push({ from: task.status, to: TASK_STATUSES.DONE, byName: 'System', note: 'Nothing overdue any more' });
    task.status = TASK_STATUSES.DONE;
    task.openKey = undefined;
    task.completedAt = new Date();
    await task.save();
  }
  return { open: stillOverdue.size };
}

module.exports = {
  creditCheck,
  receivables,
  syncOverdueTasks,
  invoiceDraft,
  createInvoice,
  cancelInvoice,
  getInvoice,
  listInvoices,
  addOpeningBill,
  importOpeningBills,
  addReceipt,
  voidReceipt,
  customerAccount,
  ledger,
  financialYear,
};
