const { SALES_ORDER_STATUSES } = require('../../config/constants');
const Customer = require('../customer/customer.model');
const SalesOrder = require('../salesOrder/salesOrder.model');
const Invoice = require('../billing/invoice.model');
const Receipt = require('../billing/receipt.model');
const CreditNote = require('../billing/creditNote.model');
const Supplier = require('../supplier/supplier.model');
const { PurchaseBill, SupplierPayment, DebitNote } = require('../purchases/purchase.models');
const { BookAccount, Voucher, BooksSettings } = require('./books.models');
const { SYSTEM_ACCOUNTS, STARTER_ACCOUNTS } = require('./books.chart');

// Automatic posting: every sale invoice, payment, order payment and order
// advance becomes a balanced voucher. Vouchers are rebuilt from their source
// document (keyed by sourceKey), so edits, cancellations and voids in billing
// always reach the books; nothing is posted twice.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Picks up documents changed since the last run, with a little overlap so a
// write that finished during the previous run is not missed.
const OVERLAP_MS = 2 * 60 * 1000;

let chartReady = null;
async function ensureChart() {
  if (!chartReady) {
    chartReady = (async () => {
      for (const a of SYSTEM_ACCOUNTS) {
        await BookAccount.updateOne({ key: a.key }, { $setOnInsert: { key: a.key, name: a.name, group: a.group } }, { upsert: true });
      }
      if (!(await BookAccount.exists({ key: { $exists: false }, customer: { $exists: false }, supplier: { $exists: false } }))) {
        await BookAccount.insertMany(STARTER_ACCOUNTS.map((a) => ({ ...a })));
      }
      const settings = await BooksSettings.findOneAndUpdate({ key: 'default' }, { $setOnInsert: { key: 'default' } }, { upsert: true, new: true });
      if (!settings.defaultBank) {
        const bank = await BookAccount.findOne({ key: 'bank' });
        await BooksSettings.updateOne({ _id: settings._id }, { $set: { defaultBank: bank._id } });
      }
    })().catch((error) => {
      chartReady = null;
      throw error;
    });
  }
  return chartReady;
}

async function systemAccounts() {
  await ensureChart();
  const rows = await BookAccount.find({ key: { $in: SYSTEM_ACCOUNTS.map((a) => a.key) } }).lean();
  return Object.fromEntries(rows.map((r) => [r.key, r._id]));
}

const customerAccountIds = new Map();
async function customerAccount(customerId) {
  const id = String(customerId);
  if (customerAccountIds.has(id)) return customerAccountIds.get(id);
  const customer = await Customer.findById(id).select('name companyName code').lean();
  const name = customer ? `${customer.companyName || customer.name}${customer.code ? ` (${customer.code})` : ''}` : `Customer ${id.slice(-6)}`;
  const doc = await BookAccount.findOneAndUpdate(
    { customer: customerId },
    { $setOnInsert: { customer: customerId, group: 'sundry_debtors' }, $set: { name } },
    { upsert: true, new: true }
  );
  customerAccountIds.set(id, doc._id);
  return doc._id;
}

const supplierAccountIds = new Map();
async function supplierAccount(supplierId) {
  const id = String(supplierId);
  if (supplierAccountIds.has(id)) return supplierAccountIds.get(id);
  const supplier = await Supplier.findById(id).select('name code').lean();
  const name = supplier ? `${supplier.name}${supplier.code ? ` (${supplier.code})` : ''}` : `Supplier ${id.slice(-6)}`;
  const doc = await BookAccount.findOneAndUpdate(
    { supplier: supplierId },
    { $setOnInsert: { supplier: supplierId, group: 'sundry_creditors' }, $set: { name } },
    { upsert: true, new: true }
  );
  supplierAccountIds.set(id, doc._id);
  return doc._id;
}

function moneyAccount(sys, settings, method) {
  return method === 'cash' ? sys.cash : settings.defaultBank || sys.bank;
}

// Writes (or updates) the voucher for one source document.
async function upsert(sourceKey, voucher) {
  const lines = voucher.lines.filter((l) => l.debit > 0.004 || l.credit > 0.004).map((l) => ({ ...l, debit: money(l.debit), credit: money(l.credit) }));
  const dr = money(lines.reduce((s, l) => s + l.debit, 0));
  const cr = money(lines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(dr - cr) > 0.01) throw new Error(`Voucher for ${sourceKey} does not balance (${dr} / ${cr})`);
  const existing = await Voucher.findOne({ sourceKey }).lean();
  if (!existing && voucher.status === 'cancelled') return 'skipped';
  const next = { ...voucher, lines, total: dr, auto: true, sourceKey };
  if (existing) {
    const same =
      existing.status === next.status &&
      existing.number === next.number &&
      new Date(existing.date).getTime() === new Date(next.date).getTime() &&
      existing.narration === next.narration &&
      JSON.stringify(existing.lines.map((l) => [String(l.account), l.debit, l.credit])) === JSON.stringify(lines.map((l) => [String(l.account), l.debit, l.credit]));
    if (same) return 'same';
    await Voucher.updateOne({ _id: existing._id }, { $set: next });
    return 'updated';
  }
  try {
    await Voucher.create(next);
  } catch (error) {
    if (error?.code === 11000 && error.keyPattern?.sourceKey) return 'same'; // another sync wrote it first
    throw error;
  }
  return 'created';
}

async function postInvoice(inv, sys) {
  const party = await customerAccount(inv.customer);
  const tax = money((inv.cgst || 0) + (inv.sgst || 0) + (inv.igst || 0));
  const roundOff = money(inv.total - (inv.taxable || 0) - tax);
  return upsert(`invoice:${inv._id}`, {
    type: 'sales',
    number: inv.number,
    date: inv.invoiceDate,
    narration: `Sale invoice${inv.orderNumber ? ` for order ${inv.orderNumber}` : ''}`,
    status: inv.status === 'cancelled' ? 'cancelled' : 'posted',
    sourceRef: inv.number,
    sourceLink: `/invoices/${inv._id}/print`,
    lines: [
      { account: party, debit: inv.total, credit: 0 },
      { account: sys.sales, debit: 0, credit: inv.taxable || 0 },
      { account: sys.output_cgst, debit: 0, credit: inv.cgst || 0 },
      { account: sys.output_sgst, debit: 0, credit: inv.sgst || 0 },
      { account: sys.output_igst, debit: 0, credit: inv.igst || 0 },
      { account: sys.round_off, debit: roundOff < 0 ? -roundOff : 0, credit: roundOff > 0 ? roundOff : 0 },
    ],
  });
}

async function postReceipt(r, sys, settings) {
  const party = await customerAccount(r.customer);
  return upsert(`receipt:${r._id}`, {
    type: 'receipt',
    number: r.number,
    date: r.receivedAt,
    narration: ['Payment received', r.reference].filter(Boolean).join(' · '),
    status: r.voidedAt ? 'cancelled' : 'posted',
    sourceRef: r.number,
    sourceLink: `/customers/${r.customer}/account`,
    lines: [
      { account: moneyAccount(sys, settings, r.method), debit: r.amount, credit: 0 },
      { account: sys.tds_receivable, debit: r.tds || 0, credit: 0 },
      { account: party, debit: 0, credit: money(r.amount + (r.tds || 0)) },
    ],
  });
}

// Advance and payments recorded on an order: money from that customer.
async function postOrderMoney(order, sys, settings) {
  if (!order.customer) return [];
  const party = await customerAccount(order.customer);
  const live = order.status !== SALES_ORDER_STATUSES.CANCELLED;
  const results = [];
  const advance = money(order.advanceAmount);
  results.push(
    await upsert(`orderadv:${order._id}`, {
      type: 'receipt',
      number: `${order.number}/ADV`,
      date: order.orderDate,
      narration: `Advance on order ${order.number}`,
      // Cancelling the order does not undo money received: the advance stays as the customer's credit.
      status: advance > 0 ? 'posted' : 'cancelled',
      sourceRef: order.number,
      sourceLink: `/sales-orders/${order._id}`,
      lines: [
        { account: moneyAccount(sys, settings, order.paymentMethod), debit: advance, credit: 0 },
        { account: party, debit: 0, credit: advance },
      ],
    })
  );
  for (const [index, p] of (order.payments || []).entries()) {
    results.push(
      await upsert(`orderpay:${order._id}:${p._id}`, {
        type: 'receipt',
        number: `${order.number}/P${index + 1}`,
        date: p.receivedAt,
        narration: [`Payment on order ${order.number}`, p.reference].filter(Boolean).join(' · '),
        status: live && !p.voidedAt ? 'posted' : 'cancelled',
        sourceRef: order.number,
        sourceLink: `/sales-orders/${order._id}`,
        lines: [
          { account: moneyAccount(sys, settings, p.method), debit: p.amount, credit: 0 },
          { account: party, debit: 0, credit: p.amount },
        ],
      })
    );
  }
  // A payment taken off the order altogether (not just voided) leaves the books too.
  const keep = new Set((order.payments || []).map((p) => `orderpay:${order._id}:${p._id}`));
  const gone = await Voucher.find({ sourceKey: new RegExp(`^orderpay:${order._id}:`), status: 'posted' }, 'sourceKey').lean();
  for (const v of gone.filter((x) => !keep.has(x.sourceKey))) {
    await Voucher.updateOne({ _id: v._id }, { $set: { status: 'cancelled' } });
    results.push('updated');
  }
  return results;
}

// Supplier bill: Dr purchases/expense and input GST, Cr the supplier.
async function postPurchaseBill(bill, sys) {
  const party = await supplierAccount(bill.supplier);
  const lines = (bill.lines || []).map((l) => ({ account: l.account || sys.purchases, debit: l.taxable, credit: 0, note: l.description }));
  const ro = Number(bill.roundOff) || 0;
  return upsert(`pbill:${bill._id}`, {
    type: 'purchase',
    number: bill.number,
    date: bill.billDate,
    narration: `Bill ${bill.supplierBillNo} from ${bill.supplierName}`,
    status: bill.status === 'cancelled' ? 'cancelled' : 'posted',
    sourceRef: bill.supplierBillNo || bill.number,
    sourceLink: `/suppliers/${bill.supplier}/account`,
    lines: [
      ...lines,
      { account: sys.input_cgst, debit: bill.cgst || 0, credit: 0 },
      { account: sys.input_sgst, debit: bill.sgst || 0, credit: 0 },
      { account: sys.input_igst, debit: bill.igst || 0, credit: 0 },
      { account: sys.round_off, debit: ro > 0 ? ro : 0, credit: ro < 0 ? -ro : 0 },
      { account: party, debit: 0, credit: bill.total },
    ],
  });
}

async function postSupplierPayment(p, sys, settings) {
  const party = await supplierAccount(p.supplier);
  return upsert(`spay:${p._id}`, {
    type: 'payment',
    number: p.number,
    date: p.paidAt,
    narration: ['Paid to supplier', p.reference].filter(Boolean).join(' · '),
    status: p.voidedAt ? 'cancelled' : 'posted',
    sourceRef: p.number,
    sourceLink: `/suppliers/${p.supplier}/account`,
    lines: [
      { account: party, debit: money(p.amount + (p.tds || 0)), credit: 0 },
      { account: p.fromAccount || moneyAccount(sys, settings, p.method), debit: 0, credit: p.amount },
      { account: sys.tds_payable, debit: 0, credit: p.tds || 0 },
    ],
  });
}

// Debit note: Dr the supplier, Cr the purchase/expense and the input GST back.
async function postDebitNote(n, sys) {
  const party = await supplierAccount(n.supplier);
  return upsert(`dnote:${n._id}`, {
    type: 'debit_note',
    number: n.number,
    date: n.date,
    narration: `Debit note: ${n.reason}`,
    status: n.status === 'cancelled' ? 'cancelled' : 'posted',
    sourceRef: n.number,
    sourceLink: `/suppliers/${n.supplier}/account`,
    lines: [
      { account: party, debit: n.total, credit: 0 },
      ...(n.lines || []).map((l) => ({ account: l.account || sys.purchases, debit: 0, credit: l.taxable, note: l.description })),
      { account: sys.input_cgst, debit: 0, credit: n.cgst || 0 },
      { account: sys.input_sgst, debit: 0, credit: n.sgst || 0 },
      { account: sys.input_igst, debit: 0, credit: n.igst || 0 },
    ],
  });
}

// Credit note: Dr sales returns and output GST, Cr the customer.
// Write-off: Dr bad debts, Cr the customer.
async function postCreditNote(n, sys) {
  const party = await customerAccount(n.customer);
  const status = n.status === 'cancelled' ? 'cancelled' : 'posted';
  const base = { number: n.number, date: n.date, status, sourceRef: n.number, sourceLink: n.kind === 'credit_note' ? `/credit-notes/${n._id}/print` : `/customers/${n.customer}/account` };
  if (n.kind === 'write_off') {
    return upsert(`cnote:${n._id}`, {
      ...base,
      type: 'journal',
      narration: `Bad debt written off${n.invoiceNumber ? ` (${n.invoiceNumber})` : ''}: ${n.reason}`,
      lines: [
        { account: sys.bad_debts, debit: n.total, credit: 0 },
        { account: party, debit: 0, credit: n.total },
      ],
    });
  }
  const ro = Number(n.roundOff) || 0;
  return upsert(`cnote:${n._id}`, {
    ...base,
    type: 'credit_note',
    narration: `Credit note${n.invoiceNumber ? ` against ${n.invoiceNumber}` : ''}: ${n.reason}`,
    lines: [
      { account: sys.sales_returns, debit: n.taxable || 0, credit: 0 },
      { account: sys.output_cgst, debit: n.cgst || 0, credit: 0 },
      { account: sys.output_sgst, debit: n.sgst || 0, credit: 0 },
      { account: sys.output_igst, debit: n.igst || 0, credit: 0 },
      { account: sys.round_off, debit: ro > 0 ? ro : 0, credit: ro < 0 ? -ro : 0 },
      { account: party, debit: 0, credit: n.total },
    ],
  });
}

let running = null;
// Brings the books up to date with billing. `full` re-checks every document.
async function syncBooks({ full = false } = {}) {
  if (running) return running;
  running = (async () => {
    await ensureChart();
    const sys = await systemAccounts();
    const settings = await BooksSettings.findOne({ key: 'default' }).lean();
    const startedAt = new Date();
    const since = full || !settings.syncedUntil ? null : new Date(new Date(settings.syncedUntil).getTime() - OVERLAP_MS);
    const changed = since ? { updatedAt: { $gte: since } } : {};
    const counts = { created: 0, updated: 0, same: 0, skipped: 0 };
    const count = (r) => (Array.isArray(r) ? r : [r]).forEach((x) => (counts[x] = (counts[x] || 0) + 1));

    for (const inv of await Invoice.find({ kind: 'sale', ...changed }).select('-lines -seller -buyer').lean()) count(await postInvoice(inv, sys));
    for (const r of await Receipt.find(changed).lean()) count(await postReceipt(r, sys, settings));
    // Any changed order (its advance may have gone to zero); on a full run, every
    // order with money on it or with a voucher already in the books.
    const posted = full || !since ? (await Voucher.distinct('sourceKey', { sourceKey: /^order(adv|pay):/ })).map((k) => k.split(':')[1]) : [];
    const orderFilter = since ? changed : { $or: [{ advanceAmount: { $gt: 0 } }, { 'payments.0': { $exists: true } }, { _id: { $in: [...new Set(posted)] } }] };
    const orders = await SalesOrder.find(orderFilter)
      .select('number status customer orderDate advanceAmount paymentMethod payments')
      .lean();
    for (const order of orders) count(await postOrderMoney(order, sys, settings));
    // An order deleted outright takes its money entries with it.
    if (!since) {
      const keys = await Voucher.find({ sourceKey: /^order(adv|pay):/, status: 'posted' }, 'sourceKey').lean();
      const ids = [...new Set(keys.map((k) => k.sourceKey.split(':')[1]))];
      const alive = new Set((await SalesOrder.find({ _id: { $in: ids } }, '_id').lean()).map((o) => String(o._id)));
      const orphans = keys.filter((k) => !alive.has(k.sourceKey.split(':')[1])).map((k) => k._id);
      if (orphans.length) await Voucher.updateMany({ _id: { $in: orphans } }, { $set: { status: 'cancelled' } });
    }
    for (const bill of await PurchaseBill.find({ kind: 'purchase', ...changed }).lean()) count(await postPurchaseBill(bill, sys));
    for (const p of await SupplierPayment.find(changed).lean()) count(await postSupplierPayment(p, sys, settings));
    for (const n of await DebitNote.find(changed).lean()) count(await postDebitNote(n, sys));
    for (const n of await CreditNote.find(changed).select('-lines -buyer -seller').lean()) count(await postCreditNote(n, sys));
    // Customer renames reach their account names on the next lookup.
    customerAccountIds.clear();
    supplierAccountIds.clear();
    await BooksSettings.updateOne({ key: 'default' }, { $set: { syncedUntil: startedAt } });
    return counts;
  })().finally(() => {
    running = null;
  });
  return running;
}

module.exports = { ensureChart, systemAccounts, customerAccount, supplierAccount, syncBooks };
