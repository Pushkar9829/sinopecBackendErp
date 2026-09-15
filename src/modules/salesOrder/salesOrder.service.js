const fs = require('fs/promises');
const path = require('path');
const {
  ATTACHMENT_KINDS,
  ORDER_PRIORITIES,
  PAYMENT_METHODS,
  PAYMENT_TERMS,
  PRODUCTION_ROUTE_LIST,
  PRODUCTION_ROUTES,
  ROLE_SLUGS,
  SALES_ORDER_STATUS_FLOW,
  SALES_ORDER_STATUSES,
} = require('../../config/constants');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const { nextSalesOrderNumber } = require('../../utils/counter');
const { hasPermission } = require('../../utils/permissions');
const customerRepo = require('../customer/customer.repo');
const { snapshotFromCustomer } = require('../customer/customer.service');
const { firstStage, itemProgress, nextStage, operatorStations, routeStages, stageRequirements } = require('../production/production.flow');
const salesOrderRepo = require('./salesOrder.repo');

const ROUTE_IDS = Object.values(PRODUCTION_ROUTES);
const ROUTE_BY_ID = new Map(PRODUCTION_ROUTE_LIST.map((route) => [route.id, route]));
const NEXT_STATUS = Object.fromEntries(
  SALES_ORDER_STATUS_FLOW.slice(0, -1).map((status, index) => [status, SALES_ORDER_STATUS_FLOW[index + 1]])
);

function str(value) {
  return value == null ? '' : String(value).trim();
}

function num(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value) {
  return value === true || value === 'true';
}

function isSuperAdmin(user) {
  return user?.role?.slug === ROLE_SLUGS.SUPER_ADMIN;
}

function canSeeCommercial(user) {
  return hasPermission(user, 'sales:read') || hasPermission(user, 'accounts:read');
}

function routeHasPrint(route) {
  return Boolean(ROUTE_BY_ID.get(route)?.stages.includes('printing'));
}

function routeHasCut(route) {
  return Boolean(ROUTE_BY_ID.get(route)?.stages.includes('cutting'));
}

function combinedSize(width, length) {
  const parts = [str(width), str(length)].filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} × ${parts[1]}`;
}

function calcLine(item) {
  const quantity = num(item.quantity);
  const rate = num(item.rate);
  const discount = num(item.discount);
  const taxPercent = num(item.taxPercent);
  const taxable = Math.max(0, quantity * rate - discount);
  const tax = (taxable * taxPercent) / 100;
  return { taxable, tax, amount: roundMoney(taxable) };
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function calcTotals(items, orderDiscount, advanceAmount) {
  let subtotal = 0;
  let tax = 0;
  for (const item of items) {
    const line = calcLine(item);
    subtotal += line.taxable;
    tax += line.tax;
  }
  const discount = Math.max(0, num(orderDiscount));
  const grandTotal = Math.max(0, subtotal - discount + tax);
  const remainingAmount = Math.max(0, grandTotal - Math.max(0, num(advanceAmount)));
  return {
    subtotal: roundMoney(subtotal),
    discount: roundMoney(discount),
    tax: roundMoney(tax),
    grandTotal: roundMoney(grandTotal),
    remainingAmount: roundMoney(remainingAmount),
  };
}

function toPublicWork(row) {
  return {
    stage: row.stage,
    machineName: row.machineName || '',
    operatorName: row.operatorName || '',
    inputQty: row.inputQty || 0,
    outputQty: row.outputQty || 0,
    wasteQty: row.wasteQty || 0,
    shift: row.shift || '',
    workDate: row.workDate || row.completedAt,
    notes: row.notes || '',
    fromStage: row.fromStage || '',
    pickedLotName: row.pickedLotName || '',
    vehicleNumber: row.vehicleNumber || '',
    handoverPerson: row.handoverPerson || '',
    deliveryPartner: row.deliveryPartner || '',
    completedAt: row.completedAt,
  };
}

function toPublicUser(user) {
  if (!user) return null;
  return {
    id: String(user._id || user.id),
    fullName: user.fullName || '',
    username: user.username || '',
  };
}

function toPublicItem(item) {
  return {
    id: String(item._id),
    product: item.product || '',
    productCode: item.productCode || '',
    productType: item.productType || '',
    size: item.size || '',
    material: item.material || '',
    thickness: item.thickness || '',
    width: item.width || '',
    length: item.length || '',
    color: item.color || '',
    quantity: item.quantity || 0,
    unit: item.unit || 'pcs',
    rate: item.rate || 0,
    discount: item.discount || 0,
    taxPercent: item.taxPercent || 0,
    amount: item.amount || 0,
    productionRoute: item.productionRoute,
    manufacturing: {
      rawMaterial: item.manufacturing?.rawMaterial || '',
      materialType: item.manufacturing?.materialType || '',
      materialGrade: item.manufacturing?.materialGrade || '',
      requiredWeight: item.manufacturing?.requiredWeight || '',
      requiredQuantity: item.manufacturing?.requiredQuantity || '',
      width: item.manufacturing?.width || '',
      length: item.manufacturing?.length || '',
      thickness: item.manufacturing?.thickness || '',
      color: item.manufacturing?.color || '',
      additives: item.manufacturing?.additives || '',
      specialRequirements: item.manufacturing?.specialRequirements || '',
    },
    roll: {
      width: item.roll?.width || '',
      length: item.roll?.length || '',
      weight: item.roll?.weight || '',
      size: item.roll?.size || '',
    },
    bag: {
      width: item.bag?.width || '',
      length: item.bag?.length || '',
      gusset: item.bag?.gusset || '',
      size: item.bag?.size || '',
    },
    printing: {
      required: Boolean(item.printing?.required),
      artwork: item.printing?.artwork || '',
      impressions: item.printing?.impressions || '',
      colorCount: item.printing?.colorCount || '',
      colors: item.printing?.colors || '',
      design: item.printing?.design || '',
      requirement: item.printing?.requirement || '',
    },
    holes: {
      required: Boolean(item.holes?.required),
      count: item.holes?.count || '',
      type: item.holes?.type || '',
      size: item.holes?.size || '',
      position: item.holes?.position || '',
    },
    tape: {
      required: Boolean(item.tape?.required),
      type: item.tape?.type || '',
    },
    currentStage: item.currentStage || '',
    nextStage: item.currentStage && item.currentStage !== 'completed' ? nextStage(item.productionRoute, item.currentStage) : '',
    stageWork: (item.stageWork || []).map(toPublicWork),
  };
}

function toPublicAttachment(attachment) {
  return {
    id: String(attachment._id),
    originalName: attachment.originalName,
    mimeType: attachment.mimeType || '',
    size: attachment.size || 0,
    kind: attachment.kind,
    uploadedBy: toPublicUser(attachment.uploadedBy),
    createdAt: attachment.createdAt,
  };
}

function toPublicOrder(order) {
  const items = (order.items || []).map((item) => ({
    ...toPublicItem(item),
    progress: itemProgress(item, order.status),
  }));

  return {
    id: String(order._id),
    number: order.number,
    orderDate: order.orderDate,
    customer: {
      id: order.customer?._id ? String(order.customer._id) : String(order.customer),
      ...(order.customerSnapshot?.toObject?.() || order.customerSnapshot || {}),
    },
    deliveryDate: order.deliveryDate,
    priority: order.priority,
    status: order.status,
    paymentTerms: order.paymentTerms,
    paymentMethod: order.paymentMethod,
    creditDays: order.creditDays || 0,
    advanceAmount: order.advanceAmount || 0,
    remainingAmount: order.remainingAmount || 0,
    paymentRemarks: order.paymentRemarks || '',
    billingAddress: order.billingAddress || '',
    shippingAddress: order.shippingAddress || '',
    deliveryLocation: order.deliveryLocation || '',
    deliveryInstructions: order.deliveryInstructions || '',
    remarks: order.remarks || '',
    productionInstructions: order.productionInstructions || '',
    items,
    subtotal: order.subtotal || 0,
    discount: order.discount || 0,
    tax: order.tax || 0,
    grandTotal: order.grandTotal || 0,
    attachments: (order.attachments || []).map(toPublicAttachment),
    createdBy: toPublicUser(order.createdBy),
    submittedAt: order.submittedAt,
    approvedAt: order.approvedAt,
    productionPlannedAt: order.productionPlannedAt,
    completedAt: order.completedAt,
    cancelledAt: order.cancelledAt,
    cancelledBy: toPublicUser(order.cancelledBy),
    cancellationReason: order.cancellationReason || '',
    nextStatus: NEXT_STATUS[order.status] || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function stripCommercial(order) {
  const next = { ...order };
  delete next.subtotal;
  delete next.discount;
  delete next.tax;
  delete next.grandTotal;
  delete next.advanceAmount;
  delete next.remainingAmount;
  delete next.paymentTerms;
  delete next.paymentMethod;
  delete next.creditDays;
  delete next.paymentRemarks;
  next.items = (next.items || []).map((item) => {
    const copy = { ...item };
    delete copy.rate;
    delete copy.discount;
    delete copy.taxPercent;
    delete copy.amount;
    return copy;
  });
  return next;
}

function abstractForStations(publicOrder, rawOrder, stations) {
  const items = (rawOrder.items || [])
    .map((rawItem, index) => {
      const published = publicOrder.items[index];
      if (!published) return null;
      const views = {};
      for (const stage of stations) {
        if (!routeStages(rawItem.productionRoute).includes(stage)) continue;
        views[stage] = stageRequirements(rawOrder, rawItem, stage);
      }
      if (!Object.keys(views).length) return null;
      return {
        id: published.id,
        product: published.product,
        productCode: published.productCode,
        quantity: published.quantity,
        unit: published.unit,
        size: published.size,
        productionRoute: published.productionRoute,
        currentStage: published.currentStage,
        progress: published.progress || [],
        stageWork: (published.stageWork || []).filter((row) => stations.includes(row.stage)),
        requirements: views,
      };
    })
    .filter(Boolean);

  const showDispatch = stations.includes('dispatch');
  return {
    id: publicOrder.id,
    number: publicOrder.number,
    status: publicOrder.status,
    priority: publicOrder.priority,
    orderDate: publicOrder.orderDate,
    deliveryDate: publicOrder.deliveryDate,
    viewMode: 'stage',
    viewStages: stations,
    customer: {
      name: publicOrder.customer?.name || '',
      code: showDispatch ? publicOrder.customer?.code || '' : '',
    },
    deliveryLocation: showDispatch ? publicOrder.deliveryLocation || '' : '',
    deliveryInstructions: showDispatch ? publicOrder.deliveryInstructions || '' : '',
    items,
    attachments: [],
  };
}

function present(order, user) {
  let publicOrder = toPublicOrder(order);
  if (!canSeeCommercial(user)) publicOrder = stripCommercial(publicOrder);
  const stations = operatorStations(user);
  if (stations.length) return abstractForStations(publicOrder, order, stations);
  return publicOrder;
}

function normalizeGroup(source = {}, fields) {
  const result = {};
  for (const field of fields) {
    result[field] = str(source[field]);
  }
  return result;
}

function normalizeItem(raw = {}) {
  const productionRoute = str(raw.productionRoute);
  if (!ROUTE_IDS.includes(productionRoute)) {
    throw new ApiError(400, 'Each line item needs a valid production route');
  }

  const manufacturing = normalizeGroup(raw.manufacturing, [
    'rawMaterial',
    'materialType',
    'materialGrade',
    'requiredWeight',
    'requiredQuantity',
    'width',
    'length',
    'thickness',
    'color',
    'additives',
    'specialRequirements',
  ]);
  const roll = normalizeGroup(raw.roll, ['width', 'length', 'weight', 'size']);
  const bag = normalizeGroup(raw.bag, ['width', 'length', 'gusset', 'size']);
  if (!roll.size) roll.size = combinedSize(roll.width, roll.length);
  if (!bag.size) bag.size = combinedSize(bag.width, bag.length);

  const printingSource = raw.printing || {};
  const printing = {
    required: routeHasPrint(productionRoute) || bool(printingSource.required),
    ...normalizeGroup(printingSource, ['artwork', 'impressions', 'colorCount', 'colors', 'design', 'requirement']),
  };

  const holesSource = raw.holes || {};
  const holes = {
    required: bool(holesSource.required),
    ...normalizeGroup(holesSource, ['count', 'type', 'size', 'position']),
  };

  const tapeSource = raw.tape || {};
  const tape = {
    required: bool(tapeSource.required),
    type: str(tapeSource.type),
  };

  const item = {
    product: str(raw.product),
    productCode: str(raw.productCode),
    productType: str(raw.productType),
    size: str(raw.size),
    material: str(raw.material),
    thickness: str(raw.thickness),
    width: str(raw.width),
    length: str(raw.length),
    color: str(raw.color),
    quantity: num(raw.quantity),
    unit: str(raw.unit) || 'pcs',
    rate: num(raw.rate),
    discount: num(raw.discount),
    taxPercent: num(raw.taxPercent),
    productionRoute,
    manufacturing,
    roll,
    bag,
    printing,
    holes,
    tape,
    currentStage: str(raw.currentStage),
    stageWork: Array.isArray(raw.stageWork) ? raw.stageWork : [],
  };
  item.amount = calcLine(item).amount;
  if (raw._id || raw.id) item._id = raw._id || raw.id;
  return item;
}

function parseDate(value, label, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ApiError(400, `${label} is required`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, `${label} is not a valid date`);
  }
  return date;
}

function assertIn(value, allowed, message) {
  if (!Object.values(allowed).includes(value)) {
    throw new ApiError(400, message);
  }
}

async function loadCustomer(customerId) {
  if (!customerId) {
    throw new ApiError(400, 'Customer is required');
  }
  const customer = await customerRepo.findById(customerId);
  if (!customer) {
    throw new ApiError(400, 'Customer not found');
  }
  if (!customer.isActive) {
    throw new ApiError(400, 'Customer is inactive');
  }
  return customer;
}

function applyTotals(doc, items, discount, advanceAmount) {
  const totals = calcTotals(items, discount, advanceAmount);
  doc.items = items;
  doc.subtotal = totals.subtotal;
  doc.discount = totals.discount;
  doc.tax = totals.tax;
  doc.grandTotal = totals.grandTotal;
  doc.remainingAmount = totals.remainingAmount;
  return totals;
}

function applyHeader(doc, payload, snapshot) {
  if (payload.orderDate !== undefined) doc.orderDate = parseDate(payload.orderDate, 'Order date', { required: true });
  if (payload.deliveryDate !== undefined) doc.deliveryDate = parseDate(payload.deliveryDate, 'Delivery date');
  if (payload.priority !== undefined) {
    assertIn(payload.priority, ORDER_PRIORITIES, 'Priority must be normal, high, or urgent');
    doc.priority = payload.priority;
  }
  if (payload.paymentTerms !== undefined) {
    assertIn(payload.paymentTerms, PAYMENT_TERMS, 'Invalid payment terms');
    doc.paymentTerms = payload.paymentTerms;
  }
  if (payload.paymentMethod !== undefined) {
    assertIn(payload.paymentMethod, PAYMENT_METHODS, 'Invalid payment method');
    doc.paymentMethod = payload.paymentMethod;
  }
  if (payload.creditDays !== undefined) doc.creditDays = Math.max(0, num(payload.creditDays));
  if (payload.advanceAmount !== undefined) doc.advanceAmount = Math.max(0, num(payload.advanceAmount));
  if (payload.paymentRemarks !== undefined) doc.paymentRemarks = str(payload.paymentRemarks);
  if (payload.billingAddress !== undefined) doc.billingAddress = str(payload.billingAddress);
  if (payload.shippingAddress !== undefined) doc.shippingAddress = str(payload.shippingAddress);
  if (payload.deliveryLocation !== undefined) doc.deliveryLocation = str(payload.deliveryLocation);
  if (payload.deliveryInstructions !== undefined) doc.deliveryInstructions = str(payload.deliveryInstructions);
  if (payload.remarks !== undefined) doc.remarks = str(payload.remarks);
  if (payload.productionInstructions !== undefined) doc.productionInstructions = str(payload.productionInstructions);
  if (payload.discount !== undefined) doc.discount = Math.max(0, num(payload.discount));

  if (snapshot) {
    if (!doc.billingAddress) doc.billingAddress = snapshot.billingAddress;
    if (!doc.shippingAddress) doc.shippingAddress = snapshot.shippingAddress;
    if (!doc.deliveryLocation) doc.deliveryLocation = snapshot.shippingAddress || snapshot.billingAddress;
  }
}

function assertDraftComplete(items) {
  if (!items.length) {
    throw new ApiError(400, 'Add at least one product');
  }
  if (!items.some((item) => item.product)) {
    throw new ApiError(400, 'Each order needs at least one product name');
  }
}

function assertReadyToSubmit(order) {
  if (!order.deliveryDate) {
    throw new ApiError(400, 'Delivery date is required before submit');
  }
  if (!order.items.length) {
    throw new ApiError(400, 'Add at least one product before submit');
  }
  order.items.forEach((item, index) => {
    const n = index + 1;
    if (!item.product) throw new ApiError(400, `Product name is required on line ${n}`);
    if (!item.productCode) throw new ApiError(400, `Product code is required on line ${n}`);
    if (!item.productType) throw new ApiError(400, `Product type is required on line ${n}`);
    if (!item.size) throw new ApiError(400, `Size is required on line ${n}`);
    if (!item.material) throw new ApiError(400, `Material is required on line ${n}`);
    if (!item.quantity) throw new ApiError(400, `Quantity is required on line ${n}`);
    if (!item.unit) throw new ApiError(400, `Unit is required on line ${n}`);
    if (item.rate < 0) throw new ApiError(400, `Rate is invalid on line ${n}`);
    if (!item.manufacturing?.rawMaterial) {
      throw new ApiError(400, `Raw material is required on line ${n}`);
    }
    if (routeHasPrint(item.productionRoute) && !item.printing?.colorCount && !item.printing?.colors) {
      throw new ApiError(400, `Printing colors are required on line ${n}`);
    }
  });
}

async function getOrderOrThrow(id) {
  const order = await salesOrderRepo.findById(id);
  if (!order) {
    throw new ApiError(404, 'Sales order not found');
  }
  return order;
}

function requireDraft(order) {
  if (order.status !== SALES_ORDER_STATUSES.DRAFT) {
    throw new ApiError(400, 'Only draft sales orders can be edited');
  }
}

async function listOrders(user) {
  const orders = await salesOrderRepo.findAll();
  return orders.map((order) => present(order, user));
}

async function getOrder(user, id) {
  const order = await getOrderOrThrow(id);
  return present(order, user);
}

async function createOrder(user, payload) {
  const customer = await loadCustomer(payload.customerId);
  const snapshot = snapshotFromCustomer(customer);
  const items = (payload.items || []).map(normalizeItem);
  assertDraftComplete(items);

  const orderDate = parseDate(payload.orderDate || new Date(), 'Order date', { required: true });
  const doc = {
    number: await nextSalesOrderNumber(orderDate),
    orderDate,
    customer: customer._id,
    customerSnapshot: snapshot,
    deliveryDate: parseDate(payload.deliveryDate, 'Delivery date'),
    priority: payload.priority || ORDER_PRIORITIES.NORMAL,
    status: SALES_ORDER_STATUSES.DRAFT,
    paymentTerms: payload.paymentTerms || PAYMENT_TERMS.CREDIT,
    paymentMethod: payload.paymentMethod || PAYMENT_METHODS.BANK_TRANSFER,
    creditDays: Math.max(0, num(payload.creditDays)),
    advanceAmount: Math.max(0, num(payload.advanceAmount)),
    paymentRemarks: str(payload.paymentRemarks),
    billingAddress: str(payload.billingAddress) || snapshot.billingAddress,
    shippingAddress: str(payload.shippingAddress) || snapshot.shippingAddress,
    deliveryLocation: str(payload.deliveryLocation) || snapshot.shippingAddress || snapshot.billingAddress,
    deliveryInstructions: str(payload.deliveryInstructions),
    remarks: str(payload.remarks),
    productionInstructions: str(payload.productionInstructions),
    createdBy: user._id,
  };

  applyTotals(doc, items, payload.discount, doc.advanceAmount);
  const created = await salesOrderRepo.create(doc);
  const loaded = await salesOrderRepo.findById(created._id);
  return present(loaded, user);
}

async function updateOrder(user, id, payload) {
  const order = await getOrderOrThrow(id);
  requireDraft(order);

  let snapshot = order.customerSnapshot;
  if (payload.customerId) {
    const customer = await loadCustomer(payload.customerId);
    snapshot = snapshotFromCustomer(customer);
    order.customer = customer._id;
    order.customerSnapshot = snapshot;
  }

  applyHeader(order, payload, snapshot);
  const items = payload.items ? payload.items.map(normalizeItem) : order.items.map((item) => normalizeItem(item));
  assertDraftComplete(items);
  applyTotals(order, items, payload.discount !== undefined ? payload.discount : order.discount, order.advanceAmount);

  await salesOrderRepo.save(order);
  const loaded = await salesOrderRepo.findById(order._id);
  return present(loaded, user);
}

async function deleteOrder(id) {
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.DRAFT) {
    throw new ApiError(400, 'Only draft sales orders can be deleted');
  }
  await salesOrderRepo.deleteById(id);
  await fs.rm(path.join(env.uploadsDir, 'sales-orders', String(id)), { recursive: true, force: true }).catch(() => {});
}

async function submitOrder(user, id) {
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.DRAFT) {
    throw new ApiError(400, 'Only draft sales orders can be submitted');
  }
  assertReadyToSubmit(order);
  order.status = SALES_ORDER_STATUSES.SUBMITTED;
  order.submittedAt = new Date();
  await salesOrderRepo.save(order);
  return present(await salesOrderRepo.findById(order._id), user);
}

async function approveOrder(user, id) {
  if (!isSuperAdmin(user)) {
    throw new ApiError(403, 'Only Super Admin can approve a sales order');
  }
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.SUBMITTED) {
    throw new ApiError(400, 'Only submitted sales orders can be approved');
  }
  order.status = SALES_ORDER_STATUSES.APPROVED;
  order.approvedAt = new Date();
  await salesOrderRepo.save(order);
  return present(await salesOrderRepo.findById(order._id), user);
}

async function planProduction(user, id) {
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.APPROVED) {
    throw new ApiError(400, 'Only approved sales orders can be planned for production');
  }
  for (const item of order.items || []) {
    item.currentStage = firstStage(item.productionRoute);
    item.stageWork = item.stageWork || [];
  }
  order.status = SALES_ORDER_STATUSES.PRODUCTION_PLANNED;
  order.productionPlannedAt = new Date();
  await salesOrderRepo.save(order);
  return present(await salesOrderRepo.findById(order._id), user);
}

async function advanceOrder(user, id) {
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.DELIVERED) {
    throw new ApiError(400, 'Operators send goods from the Delivery stage. Only a delivered order can be marked completed here.');
  }
  order.status = SALES_ORDER_STATUSES.COMPLETED;
  order.completedAt = order.completedAt || new Date();
  await salesOrderRepo.save(order);
  return present(await salesOrderRepo.findById(order._id), user);
}

async function cancelOrder(user, id, reason) {
  const order = await getOrderOrThrow(id);
  if (order.status === SALES_ORDER_STATUSES.CANCELLED) {
    throw new ApiError(400, 'Sales order is already cancelled');
  }
  if (order.status === SALES_ORDER_STATUSES.COMPLETED || order.status === SALES_ORDER_STATUSES.DELIVERED) {
    throw new ApiError(400, 'Delivered or completed sales orders cannot be cancelled');
  }

  const early = order.status === SALES_ORDER_STATUSES.DRAFT || order.status === SALES_ORDER_STATUSES.SUBMITTED;
  const salesCan = hasPermission(user, 'sales:update');
  const productionCan = hasPermission(user, 'production:update');

  if (early && !salesCan && !isSuperAdmin(user)) {
    throw new ApiError(403, 'You cannot cancel this sales order');
  }
  if (!early && !productionCan && !isSuperAdmin(user)) {
    throw new ApiError(403, 'After production starts, only Production Manager or Super Admin can cancel');
  }

  order.status = SALES_ORDER_STATUSES.CANCELLED;
  order.cancelledAt = new Date();
  order.cancelledBy = user._id;
  order.cancellationReason = str(reason);
  await salesOrderRepo.save(order);
  return present(await salesOrderRepo.findById(order._id), user);
}

function attachmentDir(orderId) {
  return path.join(env.uploadsDir, 'sales-orders', String(orderId));
}

async function addAttachment(user, id, file, kind) {
  if (!file) {
    throw new ApiError(400, 'File is required');
  }
  const order = await getOrderOrThrow(id);
  const locked = [
    SALES_ORDER_STATUSES.CANCELLED,
    SALES_ORDER_STATUSES.COMPLETED,
    SALES_ORDER_STATUSES.DISPATCHED,
  ];
  if (locked.includes(order.status)) {
    throw new ApiError(400, 'Attachments cannot be added in this status');
  }
  if (!isSuperAdmin(user) && !hasPermission(user, 'sales:update')) {
    throw new ApiError(403, 'You cannot attach files to this sales order');
  }

  const attachmentKind = str(kind) || ATTACHMENT_KINDS.OTHER;
  if (!Object.values(ATTACHMENT_KINDS).includes(attachmentKind)) {
    throw new ApiError(400, 'Invalid attachment type');
  }

  order.attachments.push({
    originalName: file.originalname,
    storedName: file.filename,
    mimeType: file.mimetype,
    size: file.size,
    kind: attachmentKind,
    uploadedBy: user._id,
  });
  await salesOrderRepo.save(order);
  return present(await salesOrderRepo.findById(order._id), user);
}

async function removeAttachment(user, id, attachmentId) {
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.DRAFT && order.status !== SALES_ORDER_STATUSES.SUBMITTED && !isSuperAdmin(user)) {
    throw new ApiError(400, 'Attachments can only be removed from draft or submitted orders');
  }
  const attachment = order.attachments.id(attachmentId);
  if (!attachment) {
    throw new ApiError(404, 'Attachment not found');
  }
  const filePath = path.join(attachmentDir(id), attachment.storedName);
  await fs.unlink(filePath).catch(() => {});
  attachment.deleteOne();
  await salesOrderRepo.save(order);
  return present(await salesOrderRepo.findById(order._id), user);
}

async function getAttachmentFile(id, attachmentId) {
  const order = await getOrderOrThrow(id);
  const attachment = order.attachments.id(attachmentId);
  if (!attachment) {
    throw new ApiError(404, 'Attachment not found');
  }
  const filePath = path.join(attachmentDir(id), attachment.storedName);
  try {
    await fs.access(filePath);
  } catch {
    throw new ApiError(404, 'File is missing');
  }
  return { filePath, originalName: attachment.originalName, mimeType: attachment.mimeType };
}

async function getSummary(user) {
  const counts = await salesOrderRepo.countByStatus();
  const byStatus = Object.fromEntries(Object.values(SALES_ORDER_STATUSES).map((status) => [status, 0]));
  let total = 0;
  for (const row of counts) {
    byStatus[row._id] = row.count;
    total += row.count;
  }
  const payload = {
    ...byStatus,
    total,
    inProductionGroup:
      byStatus[SALES_ORDER_STATUSES.PRODUCTION_PLANNED] +
      byStatus[SALES_ORDER_STATUSES.IN_PRODUCTION] +
      byStatus[SALES_ORDER_STATUSES.READY_FOR_PACKING],
    dispatchGroup:
      byStatus[SALES_ORDER_STATUSES.READY_FOR_DISPATCH] + byStatus[SALES_ORDER_STATUSES.DISPATCHED],
  };
  if (!canSeeCommercial(user) && !hasPermission(user, 'production:read') && !hasPermission(user, 'dispatch:read')) {
    return payload;
  }
  return payload;
}

function getMeta() {
  return {
    routes: PRODUCTION_ROUTE_LIST,
    statuses: SALES_ORDER_STATUS_FLOW.concat(SALES_ORDER_STATUSES.CANCELLED),
    priorities: Object.values(ORDER_PRIORITIES),
    paymentTerms: Object.values(PAYMENT_TERMS),
    paymentMethods: Object.values(PAYMENT_METHODS),
    attachmentKinds: Object.values(ATTACHMENT_KINDS),
  };
}

module.exports = {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  deleteOrder,
  submitOrder,
  approveOrder,
  planProduction,
  advanceOrder,
  cancelOrder,
  addAttachment,
  removeAttachment,
  getAttachmentFile,
  getSummary,
  getMeta,
  calcTotals,
  normalizeItem,
};
