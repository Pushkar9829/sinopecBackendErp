const ApiError = require('../../utils/ApiError');
const { hasPermission } = require('../../utils/permissions');
const { businessYmd } = require('../../utils/businessTime');
const SalesOrder = require('../salesOrder/salesOrder.model');
const Invoice = require('../billing/invoice.model');
const Receipt = require('../billing/receipt.model');
const CreditNote = require('../billing/creditNote.model');
const billing = require('../billing/billing.service');
const { parseRange, monthsOf, monthOf, inRange, deltaPct, money, DAY } = require('./reports.range');

// GST state codes, for "place of supply" the way the GST portal writes it (07-Delhi).
const STATES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland',
  '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand',
  '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};
const placeName = (code) => (code ? `${code}-${STATES[code] || 'Unknown'}` : '');
const METHOD_LABEL = { bank_transfer: 'Bank transfer', upi: 'UPI', cheque: 'Cheque', cash: 'Cash', other: 'Other', advance: 'Advance on order' };
// Inter-state sales to unregistered buyers above this go to B2C (Large) on GSTR-1.
const B2CL_LIMIT = 100000;
const DSO_WINDOW_DAYS = 90;

function canSee(user) {
  return hasPermission(user, 'accounts:read');
}

const sumBy = (rows, key) => money(rows.reduce((s, r) => s + (Number(r[key]) || 0), 0));

// Money received in a period from every source: receipts on the customer
// account, payments recorded on orders, and advances entered on orders (an
// advance on an order cancelled later was still received; it stays as the
// customer's credit). TDS the customer deducted is shown apart: no money came in.
async function collections(range) {
  const [receipts, orders] = await Promise.all([
    Receipt.find({ voidedAt: null, receivedAt: { $gte: range.start, $lte: range.end } }).populate('customer', 'code name companyName').lean(),
    SalesOrder.find({
      $or: [
        { 'payments.receivedAt': { $gte: range.start, $lte: range.end } },
        { advanceAmount: { $gt: 0 }, orderDate: { $gte: range.start, $lte: range.end } },
      ],
    })
      .select('number status orderDate advanceAmount payments customer customerSnapshot')
      .populate('customer', 'code name companyName')
      .lean(),
  ]);
  const nameOf = (c, snap) => c?.companyName || c?.name || snap?.companyName || snap?.name || '';
  const rows = receipts.map((r) => ({
    date: r.receivedAt,
    number: r.number,
    source: 'Customer account',
    customer: nameOf(r.customer),
    customerCode: r.customer?.code || '',
    customerId: r.customer?._id ? String(r.customer._id) : '',
    method: r.method,
    methodLabel: METHOD_LABEL[r.method] || r.method || '',
    reference: r.reference || '',
    amount: money(r.amount),
    tds: money(r.tds || 0),
  }));
  for (const order of orders) {
    const base = { customer: nameOf(order.customer, order.customerSnapshot), customerCode: order.customer?.code || '', customerId: order.customer?._id ? String(order.customer._id) : '' };
    if (Number(order.advanceAmount) > 0 && inRange(order.orderDate, range)) {
      rows.push({ ...base, date: order.orderDate, number: order.number, source: order.status === 'cancelled' ? 'Order advance (order cancelled)' : 'Order advance', method: 'advance', methodLabel: METHOD_LABEL.advance, reference: '', amount: money(order.advanceAmount), tds: 0 });
    }
    for (const p of order.payments || []) {
      if (p.voidedAt || !inRange(p.receivedAt, range)) continue;
      rows.push({ ...base, date: p.receivedAt, number: order.number, source: 'Order payment', method: p.method, methodLabel: METHOD_LABEL[p.method] || p.method || '', reference: p.reference || '', amount: money(p.amount), tds: 0 });
    }
  }
  return rows.sort((a, b) => new Date(a.date) - new Date(b.date));
}

function invoiceRow(inv) {
  return {
    id: String(inv._id),
    number: inv.number,
    date: inv.invoiceDate,
    dueDate: inv.dueDate,
    status: inv.status,
    customer: inv.buyer?.companyName || inv.buyer?.name || '',
    customerCode: inv.buyer?.code || '',
    customerId: String(inv.customer),
    gstin: inv.buyer?.gstin || '',
    placeOfSupply: placeName(inv.placeOfSupply),
    intraState: inv.intraState,
    orderNumber: inv.orderNumber || '',
    orderType: inv.orderType || '',
    taxable: money(inv.taxable),
    cgst: money(inv.cgst),
    sgst: money(inv.sgst),
    igst: money(inv.igst),
    roundOff: money(inv.roundOff),
    total: money(inv.total),
    cancelReason: inv.cancelReason || '',
  };
}

// GSTR-1 style tables from issued sale invoices: B2B (registered buyers, one
// row per invoice and tax rate), B2C Large and B2C Small (unregistered), and
// the HSN summary. Credit notes go to CDNR (registered buyers) or CDNUR
// (against a B2C Large invoice); the rest come off B2C Small. All of them
// come off the HSN summary.
function gstTables(invoices, notes = []) {
  const b2b = [];
  const b2cl = [];
  const b2cs = new Map();
  const hsn = new Map();
  for (const inv of invoices) {
    const byRate = new Map();
    for (const line of inv.lines || []) {
      const rate = Number(line.gstPercent) || 0;
      const r = byRate.get(rate) || { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      r.taxable = money(r.taxable + line.taxable);
      r.cgst = money(r.cgst + line.cgst);
      r.sgst = money(r.sgst + line.sgst);
      r.igst = money(r.igst + line.igst);
      byRate.set(rate, r);

      const code = String(line.hsnCode || '').trim() || 'Not set';
      const unit = String(line.unit || '').trim().toUpperCase() || 'NOS';
      const key = `${code}|${unit}|${rate}`;
      const h = hsn.get(key) || { hsn: code, description: line.product || '', unit, rate, quantity: 0, value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, invoices: new Set() };
      h.quantity = money(h.quantity + (Number(line.quantity) || 0));
      h.value = money(h.value + line.amount);
      h.taxable = money(h.taxable + line.taxable);
      h.igst = money(h.igst + line.igst);
      h.cgst = money(h.cgst + line.cgst);
      h.sgst = money(h.sgst + line.sgst);
      h.invoices.add(inv.number);
      hsn.set(key, h);
    }
    const head = { number: inv.number, date: inv.invoiceDate, value: money(inv.total), placeOfSupply: placeName(inv.placeOfSupply), customer: inv.buyer?.companyName || inv.buyer?.name || '' };
    const gstin = String(inv.buyer?.gstin || '').trim().toUpperCase();
    for (const r of byRate.values()) {
      if (gstin) b2b.push({ gstin, ...head, reverseCharge: 'N', invoiceType: 'Regular B2B', ...r });
      else if (!inv.intraState && inv.total > B2CL_LIMIT) b2cl.push({ ...head, ...r });
      else {
        const key = `${inv.placeOfSupply}|${r.rate}`;
        const s = b2cs.get(key) || { type: 'OE', placeOfSupply: head.placeOfSupply, rate: r.rate, taxable: 0, igst: 0, cgst: 0, sgst: 0, invoices: 0 };
        s.taxable = money(s.taxable + r.taxable);
        s.igst = money(s.igst + r.igst);
        s.cgst = money(s.cgst + r.cgst);
        s.sgst = money(s.sgst + r.sgst);
        s.invoices += 1;
        b2cs.set(key, s);
      }
    }
  }
  const cdnr = [];
  const cdnur = [];
  for (const note of notes) {
    const byRate = new Map();
    for (const line of note.lines || []) {
      const rate = Number(line.gstPercent) || 0;
      const r = byRate.get(rate) || { rate, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
      r.taxable = money(r.taxable + line.taxable);
      r.cgst = money(r.cgst + line.cgst);
      r.sgst = money(r.sgst + line.sgst);
      r.igst = money(r.igst + line.igst);
      byRate.set(rate, r);
      const code = String(line.hsnCode || '').trim() || 'Not set';
      const unit = String(line.unit || '').trim().toUpperCase() || 'NOS';
      const key = `${code}|${unit}|${rate}`;
      const h = hsn.get(key) || { hsn: code, description: line.description || '', unit, rate, quantity: 0, value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, invoices: new Set() };
      h.quantity = money(h.quantity - (Number(line.quantity) || 0));
      h.value = money(h.value - line.amount);
      h.taxable = money(h.taxable - line.taxable);
      h.igst = money(h.igst - line.igst);
      h.cgst = money(h.cgst - line.cgst);
      h.sgst = money(h.sgst - line.sgst);
      h.invoices.add(note.number);
      hsn.set(key, h);
    }
    const stateCode = note.buyer?.stateCode || (note.intraState ? note.seller?.stateCode : '') || '';
    const head = { number: note.number, date: note.date, noteType: 'C', value: money(note.total), placeOfSupply: placeName(stateCode), customer: note.buyer?.companyName || note.buyer?.name || '', invoiceNumber: note.invoiceNumber || '', invoiceDate: note.invoiceDate || null };
    const gstin = String(note.buyer?.gstin || '').trim().toUpperCase();
    for (const r of byRate.values()) {
      if (gstin) cdnr.push({ gstin, ...head, reverseCharge: 'N', supplyType: 'Regular B2B', ...r });
      else if (!note.intraState && note.invoiceTotal > B2CL_LIMIT) cdnur.push({ urType: 'B2CL', ...head, ...r });
      else {
        const key = `${stateCode}|${r.rate}`;
        const s = b2cs.get(key) || { type: 'OE', placeOfSupply: head.placeOfSupply, rate: r.rate, taxable: 0, igst: 0, cgst: 0, sgst: 0, invoices: 0 };
        s.taxable = money(s.taxable - r.taxable);
        s.igst = money(s.igst - r.igst);
        s.cgst = money(s.cgst - r.cgst);
        s.sgst = money(s.sgst - r.sgst);
        b2cs.set(key, s);
      }
    }
  }
  const hsnRows = [...hsn.values()].map(({ invoices: set, ...row }) => ({ ...row, invoices: set.size })).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate);
  const totals = (rows) => ({ taxable: sumBy(rows, 'taxable'), igst: sumBy(rows, 'igst'), cgst: sumBy(rows, 'cgst'), sgst: sumBy(rows, 'sgst') });
  return {
    b2b: b2b.sort((a, b) => new Date(a.date) - new Date(b.date)),
    b2cl,
    b2cs: [...b2cs.values()].sort((a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.rate - b.rate),
    hsn: hsnRows,
    cdnr: cdnr.sort((a, b) => new Date(a.date) - new Date(b.date)),
    cdnur,
    totals: { b2b: totals(b2b), b2cl: totals(b2cl), b2cs: totals([...b2cs.values()]), hsn: totals(hsnRows), cdnr: totals(cdnr), cdnur: totals(cdnur) },
    missingHsn: hsnRows.filter((r) => r.hsn === 'Not set').reduce((s, r) => s + r.invoices, 0),
  };
}

async function accountsReport(user, query) {
  if (!canSee(user)) throw new ApiError(403, 'You cannot see the accounts reports');
  const range = parseRange(query);
  const dsoFrom = new Date(Date.now() - DSO_WINDOW_DAYS * DAY);
  const [inPeriod, previousInvoices, received, previousReceived, receivables, recentBills, overrides, notes] = await Promise.all([
    Invoice.find({ kind: 'sale', invoiceDate: { $gte: range.start, $lte: range.end } }).sort({ invoiceDate: 1, number: 1 }).lean(),
    Invoice.find({ kind: 'sale', status: 'issued', invoiceDate: { $gte: range.previous.start, $lte: range.previous.end } }).select('total taxable cgst sgst igst').lean(),
    collections(range),
    collections(range.previous),
    billing.receivables(user),
    Invoice.aggregate([
      { $match: { status: 'issued', invoiceDate: { $gte: dsoFrom } } },
      { $group: { _id: '$customer', billed: { $sum: '$total' } } },
    ]),
    SalesOrder.find({ 'creditOverride.at': { $gte: range.start, $lte: range.end } })
      .select('number customer customerSnapshot grandTotal creditOverride creditCheck status')
      .populate('customer', 'code name companyName')
      .sort({ 'creditOverride.at': -1 })
      .lean(),
    CreditNote.find({ status: 'issued', date: { $gte: range.start, $lte: range.end } }).sort({ date: 1, number: 1 }).populate('invoice', 'total').lean(),
  ]);
  const creditNotes = notes.filter((n) => n.kind === 'credit_note').map((n) => ({ ...n, invoiceTotal: n.invoice?.total || 0 }));
  const writeOffs = notes.filter((n) => n.kind === 'write_off');
  const issued = inPeriod.filter((inv) => inv.status === 'issued');
  const cancelled = inPeriod.filter((inv) => inv.status === 'cancelled');

  const monthly = new Map(monthsOf(range.from, range.to).map((m) => [m, { month: m, invoices: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, tax: 0, billed: 0, collected: 0 }]));
  for (const inv of issued) {
    const row = monthly.get(monthOf(inv.invoiceDate));
    if (!row) continue;
    row.invoices += 1;
    row.taxable = money(row.taxable + inv.taxable);
    row.cgst = money(row.cgst + inv.cgst);
    row.sgst = money(row.sgst + inv.sgst);
    row.igst = money(row.igst + inv.igst);
    row.tax = money(row.cgst + row.sgst + row.igst);
    row.billed = money(row.billed + inv.total);
  }
  for (const c of received) {
    const row = monthly.get(monthOf(c.date));
    if (row) row.collected = money(row.collected + c.amount);
  }

  const byMethod = new Map();
  for (const c of received) {
    const row = byMethod.get(c.method) || { method: c.method, label: c.methodLabel, count: 0, amount: 0 };
    row.count += 1;
    row.amount = money(row.amount + c.amount);
    byMethod.set(c.method, row);
  }

  // Days of sales outstanding: what is owed, in days of recent billing.
  const billedRecent = new Map(recentBills.map((r) => [String(r._id), r.billed]));
  const dso = (outstanding, billed) => (billed > 0 ? Math.round(outstanding / (billed / DSO_WINDOW_DAYS)) : null);
  const debtors = receivables.rows
    .filter((r) => r.outstanding > 0.005)
    .map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      outstanding: r.outstanding,
      overdue: r.overdue,
      oldestOverdueDays: r.oldestOverdueDays,
      creditLimit: r.creditLimit,
      lastPaymentAt: r.lastPaymentAt,
      dso: dso(r.outstanding, billedRecent.get(r.id) || 0),
    }))
    .sort((a, b) => b.outstanding - a.outstanding);
  const totalRecent = [...billedRecent.values()].reduce((s, v) => s + v, 0);

  const billed = sumBy(issued, 'total');
  const collected = sumBy(received, 'amount');
  const prevBilled = sumBy(previousInvoices, 'total');
  const prevCollected = sumBy(previousReceived, 'amount');
  const tax = money(sumBy(issued, 'cgst') + sumBy(issued, 'sgst') + sumBy(issued, 'igst'));

  return {
    from: range.from,
    to: range.to,
    previous: { from: range.previous.from, to: range.previous.to },
    generatedAt: new Date(),
    kpis: {
      billed,
      billedDelta: deltaPct(billed, prevBilled),
      collected,
      collectedDelta: deltaPct(collected, prevCollected),
      // Settled by TDS certificates, not money: not part of `collected`.
      tdsDeducted: sumBy(received, 'tds'),
      taxable: sumBy(issued, 'taxable'),
      tax,
      invoices: issued.length,
      cancelledInvoices: cancelled.length,
      averageInvoice: issued.length ? money(billed / issued.length) : 0,
      collectionRatio: billed > 0 ? Math.round((collected / billed) * 1000) / 10 : null,
      outstanding: receivables.totals.outstanding,
      overdue: receivables.totals.overdue,
      advance: receivables.totals.advance,
      dso: dso(receivables.totals.outstanding, totalRecent),
      creditOverrides: overrides.length,
      creditNotes: sumBy(creditNotes, 'total'),
      writtenOff: sumBy(writeOffs, 'total'),
    },
    monthly: [...monthly.values()],
    collectionsByMethod: [...byMethod.values()].sort((a, b) => b.amount - a.amount),
    ageing: receivables.totals.ageing,
    debtors,
    gst: gstTables(issued, creditNotes),
    creditOverrides: overrides.map((o) => ({
      id: String(o._id),
      number: o.number,
      customer: o.customer?.companyName || o.customer?.name || o.customerSnapshot?.companyName || o.customerSnapshot?.name || '',
      amount: money(o.grandTotal),
      status: o.status,
      at: o.creditOverride.at,
      byName: o.creditOverride.byName,
      reason: o.creditOverride.reason,
      holdReasons: o.creditCheck?.reasons || [],
    })),
    invoiceRegister: inPeriod.map(invoiceRow),
    creditNoteRegister: notes.map((n) => ({
      id: String(n._id),
      kind: n.kind,
      number: n.number,
      date: n.date,
      customer: n.buyer?.companyName || n.buyer?.name || '',
      customerId: String(n.customer),
      gstin: n.buyer?.gstin || '',
      invoiceNumber: n.invoiceNumber || '',
      taxable: money(n.taxable),
      cgst: money(n.cgst),
      sgst: money(n.sgst),
      igst: money(n.igst),
      total: money(n.total),
      reason: n.reason,
    })),
    receiptRegister: received.map((c) => ({ ...c, date: c.date, day: businessYmd(c.date) })),
  };
}

module.exports = { accountsReport, gstTables, STATES };
