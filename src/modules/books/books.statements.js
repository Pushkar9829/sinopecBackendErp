const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { hasPermission, isSuperAdmin } = require('../../utils/permissions');
const { businessYmd, endOfBusinessDay } = require('../../utils/businessTime');
const Invoice = require('../billing/invoice.model');
const CreditNote = require('../billing/creditNote.model');
const { PurchaseBill, DebitNote } = require('../purchases/purchase.models');
const { BookAccount, Voucher, BooksSettings, ClosingStock, YearClose } = require('./books.models');
const { GROUPS, GROUP_BY_ID, natureOf } = require('./books.chart');
const { syncBooks, systemAccounts } = require('./books.post');
const { openingByAccount, movements } = require('./books.service');

// Final statements, worked out from the books every time (nothing is closed
// by journal entries, as in Tally):
// - Profit & loss for a period, with opening and closing stock;
// - Balance sheet on a day, with the profit carried in;
// - Cash flow (direct method) from every cash and bank entry;
// - GSTR-3B for a month, with input credit carried forward month to month;
// - closing stock values, year close (locks the year) and a Tally export.

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 24 * 60 * 60 * 1000;
const sod = (ymd) => new Date(`${ymd}T00:00:00+05:30`);
const eod = (ymd) => endOfBusinessDay(ymd);
const prevDay = (ymd) => businessYmd(new Date(sod(ymd).getTime() - 12 * 60 * 60 * 1000));
const actor = (user) => user?.fullName || user?.username || '';
const fyStartOf = (ymd) => {
  const y = Number(ymd.slice(0, 4));
  return Number(ymd.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
};
const fyEndOf = (label) => `20${label.slice(3, 5)}-03-31`;

const canView = (user) => hasPermission(user, 'accounts:read');
const canCorrect = (user) => isSuperAdmin(user) || hasPermission(user, 'accounts:update');
function assert(ok, message) {
  if (!ok) throw new ApiError(403, message);
}

// Everything the statements need, read once per request.
async function context() {
  await syncBooks();
  const [settings, accounts, stocks] = await Promise.all([
    BooksSettings.findOne({ key: 'default' }).lean(),
    BookAccount.find({}).lean(),
    ClosingStock.find({}).sort({ day: 1 }).lean(),
  ]);
  const openings = await openingByAccount(accounts);
  const startYmd = businessYmd(settings.startDate);
  const stockAccounts = accounts.filter((a) => a.group === 'stock');
  const stockAtStart = money(stockAccounts.reduce((s, a) => s + (openings.get(String(a._id)) || 0), 0));
  return { settings, accounts, openings, stocks, startYmd, stockAtStart };
}

// Stock value on a day: the last value entered on or before it, else the
// stock accounts' opening balances.
function stockOn(ctx, ymd) {
  const entry = [...ctx.stocks].reverse().find((s) => s.day <= ymd && s.day >= ctx.startYmd);
  return entry ? { value: money(entry.value), day: entry.day, exact: entry.day === ymd } : { value: ctx.stockAtStart, day: null, exact: ymd === ctx.startYmd };
}

function range(query, ctx) {
  const today = businessYmd(new Date());
  let from = YMD.test(str(query.from)) ? str(query.from) : fyStartOf(today);
  const to = YMD.test(str(query.to)) ? str(query.to) : today;
  if (from < ctx.startYmd) from = ctx.startYmd;
  if (from > to) throw new ApiError(400, 'The start date is after the end date');
  return { from, to };
}

// ---------------------------------------------------------------- profit & loss

async function pl(ctx, from, to) {
  const moves = await movements({ from: sod(from), to: eod(to) });
  const withOpenings = from <= ctx.startYmd;
  const byGroup = new Map();
  for (const a of ctx.accounts) {
    const nature = natureOf(a.group);
    if (nature !== 'income' && nature !== 'expense') continue;
    const id = String(a._id);
    const m = moves.get(id) || { debit: 0, credit: 0 };
    const bal = money((withOpenings ? ctx.openings.get(id) || 0 : 0) + m.debit - m.credit);
    if (!bal) continue;
    const amount = nature === 'income' ? -bal : bal;
    const list = byGroup.get(a.group) || [];
    list.push({ id, name: a.name, amount: money(amount) });
    byGroup.set(a.group, list);
  }
  const section = (group) => {
    const accounts = (byGroup.get(group) || []).sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
    return { id: group, label: GROUP_BY_ID.get(group).label, accounts, total: money(accounts.reduce((s, r) => s + r.amount, 0)) };
  };
  const opening = withOpenings ? { value: ctx.stockAtStart, day: ctx.startYmd, exact: true } : stockOn(ctx, prevDay(from));
  const closing = stockOn(ctx, to);
  const sales = section('sales');
  const directIncome = section('direct_income');
  const purchases = section('purchases');
  const directExpenses = section('direct_expenses');
  const indirectIncome = section('indirect_income');
  const indirectExpenses = section('indirect_expenses');
  const grossProfit = money(sales.total + directIncome.total + closing.value - opening.value - purchases.total - directExpenses.total);
  const netProfit = money(grossProfit + indirectIncome.total - indirectExpenses.total);
  const warnings = [];
  if (!closing.exact) warnings.push(closing.day ? `Closing stock on ${to} is not entered; the value from ${closing.day} is used.` : `Closing stock on ${to} is not entered; the opening stock value is used.`);
  if (!opening.exact && opening.day) warnings.push(`Opening stock is the value entered for ${opening.day}.`);
  return {
    from,
    to,
    trading: { sales, directIncome, purchases, directExpenses, openingStock: opening.value, closingStock: closing.value },
    grossProfit,
    indirectIncome,
    indirectExpenses,
    netProfit,
    revenue: money(sales.total + directIncome.total + indirectIncome.total),
    warnings,
  };
}

async function profitAndLoss(user, query = {}) {
  assert(canView(user), 'You cannot see the books');
  const ctx = await context();
  const { from, to } = range(query, ctx);
  const current = await pl(ctx, from, to);
  // Same length of time just before, for comparison.
  const days = Math.round((sod(to) - sod(from)) / DAY);
  const prevTo = prevDay(from);
  const prevFrom = businessYmd(new Date(sod(prevTo).getTime() - days * DAY + 12 * 60 * 60 * 1000));
  const previous = prevTo >= ctx.startYmd ? await pl(ctx, prevFrom < ctx.startYmd ? ctx.startYmd : prevFrom, prevTo) : null;
  return { ...current, previous: previous ? { from: previous.from, to: previous.to, grossProfit: previous.grossProfit, netProfit: previous.netProfit, revenue: previous.revenue } : null };
}

// ---------------------------------------------------------------- balance sheet

async function balanceSheet(user, query = {}) {
  assert(canView(user), 'You cannot see the books');
  const ctx = await context();
  const asOf = YMD.test(str(query.asOf)) ? str(query.asOf) : businessYmd(new Date());
  if (asOf < ctx.startYmd) throw new ApiError(400, `The books start on ${ctx.startYmd}`);
  const moves = await movements({ to: eod(asOf) });
  const fyStart = fyStartOf(asOf);
  const thisYearFrom = fyStart > ctx.startYmd ? fyStart : ctx.startYmd;
  const current = await pl(ctx, thisYearFrom, asOf);
  const earlier = thisYearFrom > ctx.startYmd ? await pl(ctx, ctx.startYmd, prevDay(thisYearFrom)) : null;

  const liabilities = new Map();
  const assets = new Map();
  const add = (side, key, label, row) => {
    const g = side.get(key) || { id: key, label, accounts: [], total: 0 };
    g.accounts.push(row);
    g.total = money(g.total + row.amount);
    side.set(key, g);
  };
  let openingDifference = 0;
  for (const a of ctx.accounts) {
    const id = String(a._id);
    const m = moves.get(id) || { debit: 0, credit: 0 };
    const opening = ctx.openings.get(id) || 0;
    openingDifference += opening;
    const nature = natureOf(a.group);
    if (nature === 'income' || nature === 'expense' || a.group === 'stock') continue;
    const bal = money(opening + m.debit - m.credit); // debit positive
    if (!bal) continue;
    const label = GROUP_BY_ID.get(a.group).label;
    const row = { id, name: a.name, amount: Math.abs(bal) };
    if (nature === 'asset') {
      if (bal > 0) add(assets, a.group, label, row);
      else add(liabilities, `${a.group}_cr`, a.group === 'sundry_debtors' ? 'Advances from customers' : a.group === 'bank' ? 'Bank overdraft' : `${label} (credit balances)`, row);
    } else if (bal < 0) add(liabilities, a.group, label, row);
    else add(assets, `${a.group}_dr`, a.group === 'sundry_creditors' ? 'Advances to suppliers' : `${label} (debit balances)`, row);
  }
  const stock = current.trading.closingStock;
  if (stock) add(assets, 'stock', 'Closing stock', { id: null, name: 'Stock in hand', amount: stock });
  const profitRows = [];
  if (earlier) profitRows.push({ id: null, name: `Profit of earlier years (${earlier.from} to ${earlier.to})`, amount: earlier.netProfit });
  profitRows.push({ id: null, name: `Profit this year (${current.from} to ${current.to})`, amount: current.netProfit });
  for (const r of profitRows) add(liabilities, 'profit_loss', 'Profit & loss account', r);
  openingDifference = money(openingDifference);
  if (openingDifference > 0) add(liabilities, 'opening_difference', 'Difference in opening balances', { id: null, name: 'Opening balances do not agree', amount: openingDifference });
  if (openingDifference < 0) add(assets, 'opening_difference', 'Difference in opening balances', { id: null, name: 'Opening balances do not agree', amount: -openingDifference });

  const order = (side) => {
    const ids = GROUPS.map((g) => g.id);
    const rank = (key) => (key === 'profit_loss' ? 1.5 : key === 'opening_difference' ? 999 : ids.indexOf(key.replace(/_(cr|dr)$/, '')) + (key.endsWith('_cr') || key.endsWith('_dr') ? 0.5 : 0));
    return [...side.values()].sort((x, y) => rank(x.id) - rank(y.id));
  };
  const liab = order(liabilities);
  const asst = order(assets);
  const totalLiabilities = money(liab.reduce((s, g) => s + g.total, 0));
  const totalAssets = money(asst.reduce((s, g) => s + g.total, 0));
  return {
    asOf,
    liabilities: liab,
    assets: asst,
    totalLiabilities,
    totalAssets,
    difference: money(totalAssets - totalLiabilities),
    netProfitThisYear: current.netProfit,
    warnings: [...current.warnings, ...(openingDifference ? ['The opening balances entered do not balance; the difference is shown separately.'] : [])],
  };
}

// ---------------------------------------------------------------- cash flow

const FLOW = {
  investing: ['fixed_assets', 'investments', 'deposits'],
  financing: ['capital', 'reserves', 'loans'],
};
const flowOf = (group) => (FLOW.investing.includes(group) ? 'investing' : FLOW.financing.includes(group) ? 'financing' : 'operating');
const FLOW_LABEL = {
  sundry_debtors: 'Received from customers',
  sundry_creditors: 'Paid to suppliers',
  duties_taxes: 'Taxes (GST, TDS)',
  sales: 'Cash sales',
};

async function cashFlow(user, query = {}) {
  assert(canView(user), 'You cannot see the books');
  const ctx = await context();
  const { from, to } = range(query, ctx);
  const moneyIds = new Set(ctx.accounts.filter((a) => ['bank', 'cash'].includes(a.group)).map((a) => String(a._id)));
  const byId = new Map(ctx.accounts.map((a) => [String(a._id), a]));
  const [before, during] = await Promise.all([movements({ before: sod(from) }), movements({ from: sod(from), to: eod(to) })]);
  const balanceOf = (map, withOpening) => money([...moneyIds].reduce((s, id) => s + (withOpening ? ctx.openings.get(id) || 0 : 0) + (map.get(id)?.debit || 0) - (map.get(id)?.credit || 0), 0));
  const opening = balanceOf(before, true);
  const net = balanceOf(during, false);

  const vouchers = await Voucher.find({ status: 'posted', date: { $gte: sod(from), $lte: eod(to) }, 'lines.account': { $in: [...moneyIds].map((id) => new mongoose.Types.ObjectId(id)) } }).lean();
  const sections = { operating: new Map(), investing: new Map(), financing: new Map() };
  for (const v of vouchers) {
    for (const l of v.lines) {
      const id = String(l.account);
      if (moneyIds.has(id)) continue; // moves between cash and bank are not a flow
      const a = byId.get(id);
      const effect = money(l.credit - l.debit); // money in when the other side is credited
      if (!effect || !a) continue;
      const kind = flowOf(a.group);
      const groupKey = a.group;
      const row = sections[kind].get(groupKey) || { id: groupKey, label: FLOW_LABEL[groupKey] || GROUP_BY_ID.get(a.group).label, inflow: 0, outflow: 0, accounts: new Map() };
      if (effect > 0) row.inflow = money(row.inflow + effect);
      else row.outflow = money(row.outflow - effect);
      const acc = row.accounts.get(id) || { id, name: a.name, amount: 0 };
      acc.amount = money(acc.amount + effect);
      row.accounts.set(id, acc);
      sections[kind].set(groupKey, row);
    }
  }
  const shape = (kind) => {
    const rows = [...sections[kind].values()].map((r) => ({ ...r, net: money(r.inflow - r.outflow), accounts: [...r.accounts.values()].sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount)) }));
    rows.sort((x, y) => Math.abs(y.net) - Math.abs(x.net));
    return { rows, inflow: money(rows.reduce((s, r) => s + r.inflow, 0)), outflow: money(rows.reduce((s, r) => s + r.outflow, 0)), net: money(rows.reduce((s, r) => s + r.net, 0)) };
  };
  const operating = shape('operating');
  const investing = shape('investing');
  const financing = shape('financing');
  return {
    from,
    to,
    opening,
    operating,
    investing,
    financing,
    net,
    closing: money(opening + net),
    check: money(operating.net + investing.net + financing.net - net),
  };
}

// ---------------------------------------------------------------- GSTR-3B

const months = (fromYmd, toMonth) => {
  const out = [];
  let y = Number(fromYmd.slice(0, 4));
  let m = Number(fromYmd.slice(5, 7));
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key >= toMonth) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
};
const monthRange = (key) => {
  const [y, m] = key.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${key}-01`, to: `${key}-${String(last).padStart(2, '0')}` };
};

// IGST credit is used first (IGST, then CGST, then SGST); then CGST credit
// (CGST, then IGST) and SGST credit (SGST, then IGST). CGST and SGST credit
// never pay each other.
function setOff(liability, credit) {
  const due = { ...liability };
  const left = { ...credit };
  const used = { igst: { igst: 0, cgst: 0, sgst: 0 }, cgst: { igst: 0, cgst: 0 }, sgst: { igst: 0, sgst: 0 } };
  const take = (from, to) => {
    const amt = money(Math.min(left[from], due[to]));
    if (amt > 0) {
      left[from] = money(left[from] - amt);
      due[to] = money(due[to] - amt);
      used[from][to] = money(used[from][to] + amt);
    }
  };
  take('igst', 'igst');
  take('igst', 'cgst');
  take('igst', 'sgst');
  take('cgst', 'cgst');
  take('cgst', 'igst');
  take('sgst', 'sgst');
  take('sgst', 'igst');
  return { cash: due, carried: left, used };
}

async function gstMonthFigures(month, sys) {
  const { from, to } = monthRange(month);
  const range = { $gte: sod(from), $lte: eod(to) };
  const [inv, notes, bills, dnotes, itcMoves] = await Promise.all([
    Invoice.aggregate([
      { $match: { kind: 'sale', status: 'issued', invoiceDate: range } },
      { $unwind: '$lines' },
      { $group: { _id: { $gt: ['$lines.gstPercent', 0] }, taxable: { $sum: '$lines.taxable' }, igst: { $sum: '$lines.igst' }, cgst: { $sum: '$lines.cgst' }, sgst: { $sum: '$lines.sgst' } } },
    ]),
    CreditNote.aggregate([
      { $match: { kind: 'credit_note', status: 'issued', date: range } },
      { $unwind: '$lines' },
      { $group: { _id: { $gt: ['$lines.gstPercent', 0] }, taxable: { $sum: '$lines.taxable' }, igst: { $sum: '$lines.igst' }, cgst: { $sum: '$lines.cgst' }, sgst: { $sum: '$lines.sgst' } } },
    ]),
    PurchaseBill.aggregate([{ $match: { kind: 'purchase', status: 'issued', billDate: range } }, { $group: { _id: null, taxable: { $sum: '$taxable' } } }]),
    DebitNote.aggregate([{ $match: { status: 'issued', date: range } }, { $group: { _id: null, taxable: { $sum: '$taxable' } } }]),
    movements({ from: sod(from), to: eod(to) }),
  ]);
  const pick = (rows, taxed) => rows.find((r) => r._id === taxed) || { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
  const less = (a, b) => ({ taxable: money(a.taxable - b.taxable), igst: money(a.igst - b.igst), cgst: money(a.cgst - b.cgst), sgst: money(a.sgst - b.sgst) });
  const outward = less(pick(inv, true), pick(notes, true));
  const nil = less(pick(inv, false), pick(notes, false));
  const net = (key) => {
    const m = itcMoves.get(String(sys[key])) || { debit: 0, credit: 0 };
    return money(m.debit - m.credit);
  };
  const itc = { igst: net('input_igst'), cgst: net('input_cgst'), sgst: net('input_sgst') };
  return { month, from, to, outward, nilRated: nil.taxable, inwardTaxable: money((bills[0]?.taxable || 0) - (dnotes[0]?.taxable || 0)), itc };
}

async function gstr3b(user, query = {}) {
  assert(canView(user), 'You cannot see the books');
  const ctx = await context();
  const today = businessYmd(new Date());
  const month = /^\d{4}-\d{2}$/.test(str(query.month)) ? str(query.month) : today.slice(0, 7);
  if (`${month}-31` < ctx.startYmd) throw new ApiError(400, `The books start on ${ctx.startYmd}`);
  const sys = await systemAccounts();
  let carried = { igst: 0, cgst: 0, sgst: 0 };
  // Credit notes larger than a month's sales lower the next month's tax.
  let short = { igst: 0, cgst: 0, sgst: 0 };
  let result = null;
  const history = [];
  for (const key of months(ctx.startYmd, month)) {
    const f = await gstMonthFigures(key, sys);
    const credit = { igst: money(carried.igst + Math.max(0, f.itc.igst)), cgst: money(carried.cgst + Math.max(0, f.itc.cgst)), sgst: money(carried.sgst + Math.max(0, f.itc.sgst)) };
    const due = { igst: money(f.outward.igst + short.igst), cgst: money(f.outward.cgst + short.cgst), sgst: money(f.outward.sgst + short.sgst) };
    const liability = { igst: Math.max(0, due.igst), cgst: Math.max(0, due.cgst), sgst: Math.max(0, due.sgst) };
    short = { igst: Math.min(0, due.igst), cgst: Math.min(0, due.cgst), sgst: Math.min(0, due.sgst) };
    const s = setOff(liability, credit);
    history.push({ month: key, tax: money(liability.igst + liability.cgst + liability.sgst), itc: money(f.itc.igst + f.itc.cgst + f.itc.sgst), cash: money(s.cash.igst + s.cash.cgst + s.cash.sgst), carried: money(s.carried.igst + s.carried.cgst + s.carried.sgst) });
    if (key === month) result = { ...f, broughtForward: carried, creditAvailable: credit, liability, ...s, negativeCarried: short };
    carried = s.carried;
  }
  return { ...result, history: history.slice(-12).reverse() };
}

// ---------------------------------------------------------------- closing stock & year close

async function listClosingStock(user) {
  assert(canView(user), 'You cannot see the books');
  const [rows, closes] = await Promise.all([ClosingStock.find({}).sort({ day: -1 }).lean(), YearClose.find({}).sort({ fy: -1 }).lean()]);
  return { stock: rows.map((r) => ({ id: String(r._id), day: r.day, value: r.value, note: r.note, byName: r.byName, updatedAt: r.updatedAt })), closedYears: closes.map((c) => ({ ...c, id: String(c._id), _id: undefined })) };
}

async function saveClosingStock(user, payload = {}) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can enter closing stock');
  const day = str(payload.day);
  if (!YMD.test(day)) throw new ApiError(400, 'Choose the date of the stock count');
  if (day > businessYmd(new Date())) throw new ApiError(400, 'The date cannot be in the future');
  const value = money(payload.value);
  if (value < 0 || !Number.isFinite(Number(payload.value))) throw new ApiError(400, 'Enter the value of stock on hand');
  const s = await BooksSettings.findOne({ key: 'default' }).lean();
  if (s?.lockDate && sod(day) <= s.lockDate) throw new ApiError(400, `The books are locked up to ${businessYmd(s.lockDate)}`);
  await ClosingStock.updateOne({ day }, { $set: { value, note: str(payload.note), byName: actor(user) } }, { upsert: true });
  return listClosingStock(user);
}

async function deleteClosingStock(user, day) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can change closing stock');
  const s = await BooksSettings.findOne({ key: 'default' }).lean();
  if (s?.lockDate && sod(day) <= s.lockDate) throw new ApiError(400, `The books are locked up to ${businessYmd(s.lockDate)}`);
  await ClosingStock.deleteOne({ day: str(day) });
  return listClosingStock(user);
}

// Closing a year: its closing stock must be entered; the books are then
// locked to 31 March and the year's result is kept.
async function closeYear(user, fy) {
  assert(canCorrect(user), 'Only Accounts managers and the owner can close a year');
  if (!/^\d{2}-\d{2}$/.test(str(fy))) throw new ApiError(400, 'Choose the year, e.g. 26-27');
  const endDay = fyEndOf(fy);
  if (endDay >= businessYmd(new Date())) throw new ApiError(400, `The year ends on ${endDay}; it can be closed after that`);
  if (await YearClose.exists({ fy })) throw new ApiError(409, `${fy} is already closed`);
  const ctx = await context();
  if (endDay < ctx.startYmd) throw new ApiError(400, 'That year is before the books start');
  const stock = await ClosingStock.findOne({ day: endDay }).lean();
  if (!stock) throw new ApiError(400, `Enter the closing stock as on ${endDay} first`);
  const startDay = fyStartOf(endDay) > ctx.startYmd ? fyStartOf(endDay) : ctx.startYmd;
  const result = await pl(ctx, startDay, endDay);
  await YearClose.create({ fy, endDay, netProfit: result.netProfit, closingStock: stock.value, closedByName: actor(user) });
  const lock = eod(endDay);
  if (!ctx.settings.lockDate || ctx.settings.lockDate < lock) await BooksSettings.updateOne({ key: 'default' }, { $set: { lockDate: lock } });
  return listClosingStock(user);
}

async function reopenYear(user, fy) {
  assert(isSuperAdmin(user), 'Only the owner can reopen a closed year');
  const close = await YearClose.findOne({ fy: str(fy) });
  if (!close) throw new ApiError(404, 'That year is not closed');
  const later = await YearClose.exists({ fy: { $gt: close.fy } });
  if (later) throw new ApiError(400, 'Reopen the later years first');
  await close.deleteOne();
  const previous = await YearClose.findOne({}).sort({ fy: -1 }).lean();
  await BooksSettings.updateOne({ key: 'default' }, { $set: { lockDate: previous ? eod(previous.endDay) : null } });
  return listClosingStock(user);
}

// ---------------------------------------------------------------- Tally export

const TALLY_GROUP = {
  capital: 'Capital Account',
  reserves: 'Reserves & Surplus',
  loans: 'Loans (Liability)',
  sundry_creditors: 'Sundry Creditors',
  duties_taxes: 'Duties & Taxes',
  provisions: 'Provisions',
  current_liabilities: 'Current Liabilities',
  fixed_assets: 'Fixed Assets',
  investments: 'Investments',
  sundry_debtors: 'Sundry Debtors',
  bank: 'Bank Accounts',
  cash: 'Cash-in-Hand',
  stock: 'Stock-in-Hand',
  loans_advances: 'Loans & Advances (Asset)',
  deposits: 'Deposits (Asset)',
  current_assets: 'Current Assets',
  sales: 'Sales Accounts',
  direct_income: 'Direct Incomes',
  indirect_income: 'Indirect Incomes',
  purchases: 'Purchase Accounts',
  direct_expenses: 'Direct Expenses',
  indirect_expenses: 'Indirect Expenses',
  suspense: 'Suspense A/c',
};
const TALLY_VOUCHER = { sales: 'Sales', receipt: 'Receipt', payment: 'Payment', journal: 'Journal', contra: 'Contra', purchase: 'Purchase', credit_note: 'Credit Note', debit_note: 'Debit Note' };
const xml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const amt = (n) => (Math.round(n * 100) / 100).toFixed(2);

// Tally XML import files (Gateway of Tally → Import → Masters, then
// Transactions): part=masters gives the ledgers with opening balances,
// part=vouchers the entries of the period. Tally writes debits as negative
// amounts.
async function tallyExport(user, query = {}) {
  assert(canView(user), 'You cannot see the books');
  const ctx = await context();
  const { from, to } = range(query, ctx);
  const vouchers = await Voucher.find({ status: 'posted', date: { $gte: sod(from), $lte: eod(to) } }).sort({ date: 1, _id: 1 }).lean();
  const byId = new Map(ctx.accounts.map((a) => [String(a._id), a]));
  const used = new Set(vouchers.flatMap((v) => v.lines.map((l) => String(l.account))));
  for (const [id, value] of ctx.openings) if (value) used.add(id);
  const ledgers = [...used].map((id) => byId.get(id)).filter(Boolean);
  // Opening balance as on the first day exported, so a new Tally company starts right.
  const before = from > ctx.startYmd ? await movements({ before: sod(from) }) : new Map();
  for (const [id, m] of before) if (m.debit || m.credit) used.add(id);
  const masters = [...used].map((id) => byId.get(id)).filter(Boolean).map((a) => {
    const m = before.get(String(a._id)) || { debit: 0, credit: 0 };
    const opening = money((ctx.openings.get(String(a._id)) || 0) + m.debit - m.credit);
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${xml(a.name)}" ACTION="Create"><NAME.LIST><NAME>${xml(a.name)}</NAME></NAME.LIST><PARENT>${xml(TALLY_GROUP[a.group] || 'Suspense A/c')}</PARENT><ISBILLWISEON>No</ISBILLWISEON><OPENINGBALANCE>${amt(-opening)}</OPENINGBALANCE></LEDGER></TALLYMESSAGE>`;
  });
  const entries = vouchers.map((v) => {
    const type = TALLY_VOUCHER[v.type] || 'Journal';
    const lines = v.lines
      .filter((l) => l.debit || l.credit)
      .map((l) => {
        const isDebit = l.debit > 0;
        return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(byId.get(String(l.account))?.name || 'Suspense A/c')}</LEDGERNAME><ISDEEMEDPOSITIVE>${isDebit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amt(isDebit ? -l.debit : l.credit)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
      })
      .join('');
    return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${type}" ACTION="Create"><DATE>${businessYmd(v.date).replace(/-/g, '')}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(v.number)}</VOUCHERNUMBER><NARRATION>${xml(v.narration)}</NARRATION><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>${lines}</VOUCHER></TALLYMESSAGE>`;
  });
  const isMasters = query.part === 'masters';
  const envelope = (report, messages) => `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>${report}</REPORTNAME></REQUESTDESC><REQUESTDATA>${messages.join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
  return {
    fileName: isMasters ? `tally-ledgers_${to}.xml` : `tally-vouchers_${from}_to_${to}.xml`,
    body: isMasters ? envelope('All Masters', masters) : envelope('Vouchers', entries),
    ledgers: masters.length,
    vouchers: vouchers.length,
  };
}

module.exports = { profitAndLoss, balanceSheet, cashFlow, gstr3b, listClosingStock, saveClosingStock, deleteClosingStock, closeYear, reopenYear, tallyExport, setOff };
