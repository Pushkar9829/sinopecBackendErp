const ApiError = require('../../utils/ApiError');
const { hasPermission } = require('../../utils/permissions');
const { SALES_ORDER_STATUSES } = require('../../config/constants');
const InventoryItem = require('../inventory/item.model');
const SalesOrder = require('../salesOrder/salesOrder.model');
const { parseRange, inRange, money, DAY } = require('./reports.range');

const CATEGORY_LABEL = { raw: 'Raw material', output: 'Finished goods', waste: 'Waste / scrap' };
const SLOW_BUCKETS = [30, 60, 90];
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function canSee(user) {
  return hasPermission(user, 'inventory:read') || hasPermission(user, 'production:read');
}

function unitsText(map) {
  return Object.entries(map)
    .filter(([, q]) => q > 0)
    .map(([u, q]) => `${r2(q).toLocaleString('en-IN')} ${u}`)
    .join(' · ');
}

// Stock is kept as lots with their current quantity (no movement history), so
// "now" figures are exact; "added in the period" means lots created then, with
// what is left of them today.
async function stockReport(user, query) {
  if (!canSee(user)) throw new ApiError(403, 'You cannot see the stock reports');
  const range = parseRange(query);
  const now = Date.now();
  const [lots, worked] = await Promise.all([
    InventoryItem.find({ isActive: true }).populate('stage', 'name').lean(),
    SalesOrder.find({ status: { $ne: SALES_ORDER_STATUSES.CANCELLED }, 'items.stageWork': { $elemMatch: { stage: 'rolling', workDate: { $gte: range.start, $lte: range.end } } } })
      .select('items.material items.manufacturing.rawMaterial items.stageWork')
      .lean(),
  ]);

  const rows = lots.map((lot) => {
    const price = lot.category === 'waste' ? null : lot.unitPrice;
    const value = price != null ? money((Number(lot.quantity) || 0) * price) : null;
    const idle = Math.floor((now - new Date(lot.updatedAt || lot.createdAt).getTime()) / DAY);
    return {
      id: String(lot._id),
      name: lot.name,
      category: lot.category,
      categoryLabel: CATEGORY_LABEL[lot.category] || lot.category,
      kind: lot.kind,
      materialType: lot.materialType || '',
      stage: lot.stage?.name || lot.wipStage || '',
      supplier: lot.supplierName || '',
      quantity: r2(lot.quantity),
      unit: lot.unit,
      unitPrice: price,
      value,
      addedAt: lot.createdAt,
      changedAt: lot.updatedAt,
      idleDays: idle,
    };
  });
  const inStock = rows.filter((r) => r.quantity > 0);

  const categories = Object.keys(CATEGORY_LABEL).map((category) => {
    const list = inStock.filter((r) => r.category === category);
    const units = {};
    for (const r of list) units[r.unit] = (units[r.unit] || 0) + r.quantity;
    const priced = list.filter((r) => r.value != null);
    return { category, label: CATEGORY_LABEL[category], lots: list.length, quantityText: unitsText(units), value: money(priced.reduce((s, r) => s + r.value, 0)), unpriced: category === 'waste' ? 0 : list.length - priced.length };
  });

  // Lots added in the period, by supplier (raw material only).
  const added = rows.filter((r) => r.category === 'raw' && r.kind !== 'wip' && inRange(r.addedAt, range));
  const bySupplier = new Map();
  for (const r of added) {
    const key = r.supplier || 'No supplier';
    const s = bySupplier.get(key) || { supplier: key, lots: 0, units: {}, value: 0, materials: new Set() };
    s.lots += 1;
    s.units[r.unit] = (s.units[r.unit] || 0) + r.quantity;
    s.value = money(s.value + (r.value || 0));
    s.materials.add(r.materialType || r.name);
    bySupplier.set(key, s);
  }

  // Material used at rolling in the period, and the waste made from it (kg).
  const used = new Map();
  for (const order of worked) {
    for (const item of order.items || []) {
      const material = item.material || item.manufacturing?.rawMaterial || 'Not set';
      for (const w of item.stageWork || []) {
        if (w.stage !== 'rolling' || !inRange(w.workDate, range)) continue;
        const m = used.get(material) || { material, input: 0, output: 0, waste: 0, entries: 0 };
        m.input += Number(w.inputQty) || 0;
        m.output += Number(w.outputQty) || 0;
        m.waste += Number(w.wasteQty) || 0;
        m.entries += 1;
        used.set(material, m);
      }
    }
  }

  const slow = inStock
    .filter((r) => r.kind !== 'wip' && r.idleDays >= SLOW_BUCKETS[0])
    .sort((a, b) => (b.value || 0) - (a.value || 0) || b.idleDays - a.idleDays);
  const wip = inStock.filter((r) => r.kind === 'wip');
  const totalValue = money(categories.reduce((s, c) => s + c.value, 0));

  return {
    from: range.from,
    to: range.to,
    generatedAt: new Date(),
    kpis: {
      totalValue,
      rawValue: categories.find((c) => c.category === 'raw').value,
      outputValue: categories.find((c) => c.category === 'output').value,
      wasteText: categories.find((c) => c.category === 'waste').quantityText,
      lotsInStock: inStock.length,
      unpriced: categories.filter((c) => c.category !== 'waste').reduce((s, c) => s + c.unpriced, 0),
      slowLots: slow.length,
      slowValue: money(slow.reduce((s, r) => s + (r.value || 0), 0)),
      addedLots: added.length,
      materialUsedKg: r2([...used.values()].reduce((s, m) => s + m.input, 0)),
      wipLots: wip.length,
    },
    categories,
    lots: inStock.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name)),
    bySupplier: [...bySupplier.values()].map((s) => ({ supplier: s.supplier, lots: s.lots, quantityText: unitsText(s.units), value: s.value, materials: [...s.materials].join(', ') })).sort((a, b) => b.value - a.value || b.lots - a.lots),
    added: added.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)),
    materialUse: [...used.values()].map((m) => ({ material: m.material, entries: m.entries, input: r2(m.input), output: r2(m.output), waste: r2(m.waste), wastePct: m.output + m.waste > 0 ? Math.round((m.waste / (m.output + m.waste)) * 1000) / 10 : null })).sort((a, b) => b.input - a.input),
    slow: slow.map((r) => ({ ...r, bucket: r.idleDays >= 90 ? '90+ days' : r.idleDays >= 60 ? '60–89 days' : '30–59 days' })),
    wip,
  };
}

module.exports = { stockReport };
