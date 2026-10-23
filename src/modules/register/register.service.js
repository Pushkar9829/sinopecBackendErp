const { ROLE_SLUGS, SALES_ORDER_STATUSES } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { hasPermission } = require('../../utils/permissions');
const salesOrderRepo = require('../salesOrder/salesOrder.repo');
const {
  FLOOR_ORDER_STATUSES,
  FLOOR_STAGES,
  canReadStage,
  canWorkStage,
  itemVisibleAtStage,
  registerSpecs,
  routeStages,
  stageName,
  stageStats,
  stageUnit,
  takesNoStock,
  visibleStages,
  wasteUnitOf,
} = require('../production/production.flow');
const repo = require('./register.repo');

const REGISTER_STATUSES = [
  SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
  SALES_ORDER_STATUSES.IN_PRODUCTION,
  SALES_ORDER_STATUSES.READY_FOR_PACKING,
  SALES_ORDER_STATUSES.PACKED,
  SALES_ORDER_STATUSES.READY_FOR_DISPATCH,
  SALES_ORDER_STATUSES.DISPATCHED,
  SALES_ORDER_STATUSES.DELIVERED,
  SALES_ORDER_STATUSES.COMPLETED,
];

function canViewBooks(user) {
  return (
    visibleStages(user).length > 0 ||
    hasPermission(user, 'sales:read') ||
    hasPermission(user, 'accounts:read') ||
    hasPermission(user, 'inventory:read')
  );
}

function assertCanView(user) {
  if (canViewBooks(user)) return;
  throw new ApiError(403, 'You cannot view the register');
}

function canReadBook(user, stage) {
  if (canReadStage(user, stage)) return true;
  return (
    hasPermission(user, 'sales:read') ||
    hasPermission(user, 'accounts:read') ||
    hasPermission(user, 'inventory:read')
  );
}

function stagesForOrder(order) {
  const ids = [];
  for (const item of order.items || []) {
    for (const stage of routeStages(item.productionRoute)) {
      if (!ids.includes(stage)) ids.push(stage);
    }
  }
  return ids;
}

function customerNameOf(order) {
  return order.customerSnapshot?.name || order.customer?.name || '';
}

function seesCustomerName(user) {
  return user?.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
}

function customerNameFor(user, order) {
  return seesCustomerName(user) ? customerNameOf(order) : '';
}

function customerCodeOf(order) {
  return order.customerSnapshot?.code || order.customer?.code || '';
}

function publicDetails(raw) {
  const source = raw && typeof raw.toObject === 'function' ? raw.toObject() : raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key || key.startsWith('_') || key.startsWith('$')) continue;
    if (value == null || value === '') continue;
    if (typeof value === 'object') continue;
    out[key] = String(value);
  }
  return out;
}

function entryFromWork(item, row) {
  return {
    // Same id as the production row it mirrors, so a register rebuilt from the
    // order keeps the ids the screen already holds.
    ...(row._id ? { _id: row._id } : {}),
    stage: row.stage,
    itemId: item._id,
    workId: row._id || null,
    product: item.product || '',
    productCode: item.productCode || '',
    unit: stageUnit(item, row.stage),
    inputQty: Number(row.inputQty) || 0,
    outputQty: Number(row.outputQty) || 0,
    wasteQty: Number(row.wasteQty) || 0,
    wasteUnit: Number(row.wasteQty) > 0 ? wasteUnitOf(item, row) : '',
    workDate: row.workDate || row.completedAt || new Date(),
    notes: row.notes || '',
    machineName: row.machineName || '',
    pickedLotName: row.pickedLotName || '',
    vehicleNumber: row.vehicleNumber || '',
    handoverPerson: row.handoverPerson || '',
    deliveryPartner: row.deliveryPartner || '',
    details: publicDetails(row.details),
    markedBy: row.operator || null,
    markedByName: row.operatorName || '',
    markedAt: row.completedAt || new Date(),
  };
}

function toPublicEntry(row) {
  return {
    id: String(row._id),
    stage: row.stage,
    itemId: row.itemId ? String(row.itemId) : '',
    product: row.product || '',
    productCode: row.productCode || '',
    unit: row.unit || 'pcs',
    inputQty: row.inputQty || 0,
    outputQty: row.outputQty || 0,
    wasteQty: row.wasteQty || 0,
    wasteUnit: row.wasteQty ? row.wasteUnit || row.unit || 'pcs' : '',
    workDate: row.workDate,
    notes: row.notes || '',
    machineName: row.machineName || '',
    pickedLotName: row.pickedLotName || '',
    vehicleNumber: row.vehicleNumber || '',
    handoverPerson: row.handoverPerson || '',
    deliveryPartner: row.deliveryPartner || '',
    details: publicDetails(row.details),
    markedByName: row.markedByName || '',
    markedAt: row.markedAt,
  };
}

function readableStages(user, order) {
  return stagesForOrder(order).filter((stage) => canReadBook(user, stage));
}

function stageLabel(stage) {
  return FLOOR_STAGES.find((item) => item.id === stage)?.label || stage;
}

function entryKey(itemId, row) {
  const at = new Date(row.completedAt || row.markedAt || row.workDate || 0).getTime();
  return [
    String(itemId || ''),
    row.stage || '',
    at,
    Number(row.inputQty) || 0,
    Number(row.outputQty) || 0,
    Number(row.wasteQty) || 0,
  ].join('|');
}

function entriesFromWork(order) {
  const entries = [];
  for (const item of order.items || []) {
    for (const row of item.stageWork || []) {
      if (!row?.stage) continue;
      entries.push(entryFromWork(item, row));
    }
  }
  return entries;
}

async function ensureRegister(order, preloaded) {
  const stages = stagesForOrder(order);
  const customerName = customerNameOf(order);
  let doc = preloaded === undefined ? await repo.findByOrderId(order._id) : preloaded;
  if (!doc) {
    try {
      return await repo.create({
        salesOrder: order._id,
        orderNumber: order.number,
        customerName,
        stages: stages.map((stage) => ({ stage })),
        entries: entriesFromWork(order),
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      doc = await repo.findByOrderId(order._id);
      if (!doc) throw error;
    }
  }

  // Compare with schema defaults applied: a lean (plain) register has no
  // value at all where a full document would hold '' or {}.
  let dirty = false;
  if ((doc.orderNumber || '') !== (order.number || '')) {
    doc.orderNumber = order.number;
    dirty = true;
  }
  if ((doc.customerName || '') !== (customerName || '')) {
    doc.customerName = customerName;
    dirty = true;
  }
  const haveStages = new Set((doc.stages || []).map((row) => row.stage));
  for (const stage of stages) {
    if (!haveStages.has(stage)) {
      doc.stages.push({ stage });
      dirty = true;
    }
  }
  // The order's stageWork is the source of truth: refresh matching entries, add missing ones, drop orphans.
  const byWork = new Map((doc.entries || []).filter((row) => row.workId).map((row) => [String(row.workId), row]));
  const byKey = new Map((doc.entries || []).map((row) => [entryKey(row.itemId, row), row]));
  const kept = new Set();
  for (const entry of entriesFromWork(order)) {
    const existing = (entry.workId && byWork.get(String(entry.workId))) || byKey.get(entryKey(entry.itemId, entry));
    if (!existing) {
      doc.entries.push(entry);
      kept.add(doc.entries[doc.entries.length - 1]);
      dirty = true;
      continue;
    }
    kept.add(existing);
    for (const field of SYNCED_FIELDS) {
      const next = entry[field];
      const same =
        field === 'details'
          ? JSON.stringify(existing[field] ?? {}) === JSON.stringify(next ?? {})
          : field === 'workDate'
            ? JSON.stringify(existing[field] ?? null) === JSON.stringify(next ?? null)
            : String(existing[field] ?? '') === String(next ?? '');
      if (!same) {
        existing[field] = next;
        dirty = true;
      }
    }
  }
  const before = doc.entries.length;
  doc.entries = doc.entries.filter((row) => kept.has(row));
  if (doc.entries.length !== before) dirty = true;
  if (dirty && typeof doc.save !== 'function') {
    // Read from a lean list preload: redo the sync on a real document so
    // the change is saved (and new entries get their ids).
    const real = await repo.findByOrderId(order._id);
    return real ? ensureRegister(order, real) : doc;
  }
  if (dirty) {
    try {
      await repo.save(doc);
    } catch (error) {
      // Two screens opened the same register at once and both rebuilt it from
      // the order. The other one won; its copy is just as current.
      if (error?.name !== 'VersionError') throw error;
      return (await repo.findByOrderId(order._id)) || doc;
    }
  }
  return doc;
}

const SYNCED_FIELDS = [
  'workId',
  'inputQty',
  'outputQty',
  'wasteQty',
  'wasteUnit',
  'workDate',
  'notes',
  'machineName',
  'pickedLotName',
  'vehicleNumber',
  'handoverPerson',
  'deliveryPartner',
  'details',
];

async function preloadRegisters(orders) {
  const docs = await repo.findByOrderIds(orders.map((order) => order._id), { lean: true });
  return new Map(docs.map((doc) => [String(doc.salesOrder), doc]));
}

async function openForOrder(order) {
  return ensureRegister(order);
}

async function recordMark(order, item, workRow) {
  if (!workRow?.stage) return null;
  const existing = await repo.findByOrderId(order._id);
  if (!existing) return ensureRegister(order);

  existing.orderNumber = order.number;
  existing.customerName = customerNameOf(order);
  const have = new Set((existing.stages || []).map((row) => row.stage));
  if (!have.has(workRow.stage)) existing.stages.push({ stage: workRow.stage });
  const next = entryFromWork(item, workRow);
  const key = entryKey(item._id, next);
  const haveEntries = new Set((existing.entries || []).map((row) => entryKey(row.itemId, row)));
  if (haveEntries.has(key)) return existing;
  existing.entries.push(next);
  return repo.save(existing);
}

function lineView(user, order, item, stage, doc) {
  const stats = stageStats(item, stage);
  const ready = itemVisibleAtStage(item, stage, order.status);
  const noStock = takesNoStock(item.productionRoute, stage);
  const process = stage === 'other' ? stageName(item, stage) : '';
  const entries = (doc.entries || [])
    .filter((row) => row.stage === stage && String(row.itemId) === String(item._id))
    .map((row) => ({ ...toPublicEntry(row), noStock, process }))
    .sort((a, b) => new Date(a.workDate || a.markedAt) - new Date(b.workDate || b.markedAt));
  return {
    itemId: String(item._id),
    product: item.product || '',
    productCode: item.productCode || '',
    // The process name on an "Other process" line; such steps take no stock.
    process,
    noStock,
    quantity: stats.target,
    unit: stats.unit,
    output: stats.output,
    waste: stats.waste,
    wasteUnit: stats.wasteUnit,
    wasteText: stats.wasteText,
    remaining: stats.remaining,
    done: stats.done,
    closedShort: Boolean(stats.closedShort),
    ready,
    canMark: ready && canWorkStage(user, stage),
    // A production manager may close a making stage that came in under target.
    canCloseShort:
      stage !== 'dispatch' &&
      !stats.done &&
      stats.output > 0 &&
      FLOOR_ORDER_STATUSES.includes(order.status) &&
      (user?.role?.slug === ROLE_SLUGS.SUPER_ADMIN || hasPermission(user, 'production:update')),
    jobId: `${order._id}:${item._id}:${stage}`,
    specs: registerSpecs(order, item, stage),
    jobFields: stage === 'dispatch' ? [] : require('../task/task.jobsheet').stageJob(order, item, stage).fields,
    instructions: order.productionInstructions || '',
    entries,
  };
}

function presentOrder(user, order, doc) {
  const stages = readableStages(user, order).map((stage) => {
    const lines = (order.items || [])
      .filter((item) => routeStages(item.productionRoute).includes(stage))
      .map((item) => lineView(user, order, item, stage, doc));
    const marked = lines.reduce((sum, line) => sum + line.entries.length, 0);
    return {
      id: stage,
      label: stageLabel(stage),
      marked,
      open: lines.some((line) => line.ready),
      lines,
    };
  });

  return {
    id: String(doc._id),
    orderId: String(order._id),
    orderNumber: order.number,
    orderType: order.orderType || 'sales_order',
    customerName: customerNameFor(user, order),
    customerCode: customerCodeOf(order),
    status: order.status,
    priority: order.priority,
    deliveryDate: order.deliveryDate,
    stages,
  };
}

// Completed orders stay in the books for this long; older ones only make every
// register screen slower. Pass ?days= to look further back.
const COMPLETED_HISTORY_DAYS = 90;

function registerOrderFilter(query = {}) {
  const days = Math.min(Math.max(Number(query.days) || COMPLETED_HISTORY_DAYS, 1), 3660);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const open = REGISTER_STATUSES.filter((status) => status !== SALES_ORDER_STATUSES.COMPLETED);
  return {
    $or: [
      { status: { $in: open } },
      { status: SALES_ORDER_STATUSES.COMPLETED, $or: [{ completedAt: { $gte: since } }, { completedAt: null, updatedAt: { $gte: since } }] },
    ],
  };
}

async function list(user, query = {}) {
  assertCanView(user);
  const orders = await salesOrderRepo.findAllForFloor(registerOrderFilter(query), { lean: true });
  const docs = await preloadRegisters(orders);
  const rows = [];
  for (const order of orders) {
    const stages = readableStages(user, order);
    if (!stages.length) continue;
    const doc = await ensureRegister(order, docs.get(String(order._id)) || null);
    const summary = presentOrder(user, order, doc);
    rows.push({
      id: summary.id,
      orderId: summary.orderId,
      orderNumber: summary.orderNumber,
      orderType: summary.orderType,
      customerName: summary.customerName,
      customerCode: summary.customerCode,
      status: summary.status,
      priority: summary.priority,
      deliveryDate: summary.deliveryDate,
      stages: summary.stages.map((stage) => ({
        id: stage.id,
        label: stage.label,
        marked: stage.marked,
        open: stage.open,
        lines: stage.lines.length,
      })),
    });
  }
  return rows;
}

async function getByOrder(user, orderId) {
  assertCanView(user);
  const order = await salesOrderRepo.findById(orderId);
  if (!order) throw new ApiError(404, 'Order not found');
  if (!REGISTER_STATUSES.includes(order.status)) {
    throw new ApiError(400, 'This order has no register yet');
  }
  if (!readableStages(user, order).length) {
    throw new ApiError(403, 'You cannot view this register');
  }
  const doc = await ensureRegister(order);
  const book = presentOrder(user, order, doc);
  const lotCache = require('../production/production.service').createLotCache();
  for (const stage of book.stages) {
    for (const line of stage.lines) {
      const item = (order.items || []).find((row) => String(row._id) === line.itemId);
      const inHand = item?.stagePickup?.stage === stage.id && Number(item.stagePickup.qty) > 0;
      const lots =
        line.ready && item
          ? await require('../production/production.service').sourceLots(order, item, stage.id, lotCache)
          : [];
      const hasMaterial = inHand || line.noStock || lots.some((lot) => Number(lot.quantity) > 0);
      line.canEnter = Boolean(line.canMark && hasMaterial);
      line.blockedReason = line.canMark && !hasMaterial ? 'Nothing in store' : '';
    }
  }
  return book;
}

async function getStage(user, stage, query = {}) {
  if (!FLOOR_STAGES.some((item) => item.id === stage)) {
    throw new ApiError(400, 'Unknown production stage');
  }
  if (!canReadBook(user, stage)) {
    throw new ApiError(403, 'You cannot view this stage register');
  }

  const orders = await salesOrderRepo.findAllForFloor(registerOrderFilter(query), { lean: true });
  const docs = await preloadRegisters(orders);
  const lotCache = require('../production/production.service').createLotCache();
  const open = [];
  const entries = [];
  for (const order of orders) {
    if (!stagesForOrder(order).includes(stage)) continue;
    const doc = await ensureRegister(order, docs.get(String(order._id)) || null);
    for (const item of order.items || []) {
      if (!routeStages(item.productionRoute).includes(stage)) continue;
      const line = lineView(user, order, item, stage, doc);
      const sourceLots = line.ready
        ? await require('../production/production.service').sourceLots(order, item, stage, lotCache)
        : [];
      const inHand = item.stagePickup?.stage === stage && Number(item.stagePickup.qty) > 0;
      const hasMaterial = inHand || line.noStock || sourceLots.some((lot) => Number(lot.quantity) > 0);
      if (line.ready && hasMaterial) {
        open.push({
          orderId: String(order._id),
          orderNumber: order.number,
          customerName: customerNameFor(user, order),
          customerCode: customerCodeOf(order),
          priority: order.priority,
          deliveryDate: order.deliveryDate,
          sourceLots,
          ...line,
          pickup: inHand
            ? {
                qty: Number(item.stagePickup.qty) || 0,
                unit: item.stagePickup.unit || line.unit || '',
                lotName: item.stagePickup.lotName || '',
              }
            : null,
        });
      }
      for (const entry of line.entries) {
        entries.push({
          ...entry,
          orderId: String(order._id),
          orderNumber: order.number,
          customerName: customerNameFor(user, order),
          customerCode: customerCodeOf(order),
          editable: order.status !== SALES_ORDER_STATUSES.COMPLETED,
        });
      }
    }
  }

  entries.sort((a, b) => new Date(b.markedAt || b.workDate) - new Date(a.markedAt || a.workDate));
  return {
    stage,
    label: stageLabel(stage),
    canMark: canWorkStage(user, stage),
    open,
    entries,
  };
}

function artworkImage(image) {
  const url = image?.url || '';
  const dataUrl = url ? '' : image?.dataUrl || '';
  if (!url && !dataUrl) return null;
  return { originalName: image.originalName || '', mimeType: image.mimeType || '', url, dataUrl };
}

async function loadArtworkOrder(user, orderId) {
  if (!canReadBook(user, 'printing')) {
    throw new ApiError(403, 'You cannot view printing artwork');
  }
  const order = await salesOrderRepo.findById(orderId);
  if (!order) throw new ApiError(404, 'Order not found');
  if (!REGISTER_STATUSES.includes(order.status)) {
    throw new ApiError(404, 'This order has no artwork on the floor');
  }
  if (!(order.items || []).some((item) => routeStages(item.productionRoute).includes('printing'))) {
    throw new ApiError(404, 'Nothing on this order is printed');
  }
  return order;
}

async function getArtwork(user, orderId, itemId) {
  const order = await loadArtworkOrder(user, orderId);
  const item = (order.items || []).id(itemId);
  if (!item) throw new ApiError(404, 'Line item not found');
  const images = (item.images?.length ? item.images : [item.image]).map(artworkImage).filter(Boolean);
  const files = (order.attachments || [])
    .filter((attachment) => attachment.kind === 'artwork')
    .map((attachment) => ({
      id: String(attachment._id),
      originalName: attachment.originalName || 'Artwork',
      mimeType: attachment.mimeType || '',
      size: attachment.size || 0,
    }));
  return {
    orderId: String(order._id),
    orderNumber: order.number,
    product: item.product || '',
    productCode: item.productCode || '',
    note: [item.printing?.artwork, item.printing?.requirement].filter(Boolean).join('; '),
    design: item.printing?.design || '',
    colors: item.printing?.colors || '',
    colorCount: item.printing?.colorCount || '',
    impressions: item.printing?.impressions || '',
    images,
    files,
  };
}

async function getArtworkFile(user, orderId, attachmentId) {
  const order = await loadArtworkOrder(user, orderId);
  const attachment = (order.attachments || []).id(attachmentId);
  if (!attachment || attachment.kind !== 'artwork') throw new ApiError(404, 'Artwork file not found');
  return require('../salesOrder/salesOrder.service').getAttachmentFile(orderId, attachmentId);
}

async function findEntry(order, entryId) {
  const doc = await ensureRegister(order);
  // Older entries have their own id; newer ones share the production row's
  // id (workId). Accept either so links survive a rebuild.
  const entry = doc.entries.id(entryId) || (doc.entries || []).find((row) => String(row.workId || '') === String(entryId));
  if (!entry) throw new ApiError(404, 'That register entry was not found');
  return { doc, entry };
}

function workRowFor(order, entry) {
  const item = (order.items || []).id(entry.itemId);
  if (!item) return { item: null, row: null };
  const rows = item.stageWork || [];
  let row = entry.workId ? rows.id(entry.workId) : null;
  if (!row) {
    const key = entryKey(entry.itemId, entry);
    row = rows.find((candidate) => entryKey(item._id, candidate) === key) || null;
  }
  return { item, row };
}

async function updateEntry(doc, entry, item, row) {
  // eslint-disable-next-line no-unused-vars
  const { _id, ...fresh } = entryFromWork(item, row); // never change an existing entry's id
  for (const [key, value] of Object.entries(fresh)) entry[key] = value;
  doc.markModified('entries');
  return repo.save(doc);
}

async function removeEntry(doc, entry) {
  doc.entries.pull(entry._id);
  return repo.save(doc);
}

module.exports = {
  getArtwork,
  getArtworkFile,
  findEntry,
  workRowFor,
  updateEntry,
  removeEntry,
  openForOrder,
  recordMark,
  list,
  getByOrder,
  getStage,
};
