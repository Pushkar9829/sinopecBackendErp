const fs = require('fs/promises');
const path = require('path');
const mongoose = require('mongoose');
const {
  ATTACHMENT_KINDS,
  ORDER_PRIORITIES,
  ORDER_TYPES,
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
const { snapshotFromCustomer, attachProductsFromOrder } = require('../customer/customer.service');
const {
  firstStage,
  itemProgress,
  nextStage,
  operatorStations,
  routeStages,
  stageRequirements,
  stageStats,
} = require('../production/production.flow');
const { uploadBuffer, deleteStoredObject } = require('../../utils/storage');
const salesOrderRepo = require('./salesOrder.repo');
const rateCalculator = require('../rateCalculator/rateCalculator.service');
const taskHooks = require('../task/task.hooks');

const ROUTE_IDS = Object.values(PRODUCTION_ROUTES);
const ROUTE_BY_ID = new Map(PRODUCTION_ROUTE_LIST.map((route) => [route.id, route]));

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

function calcTotals(items, orderDiscount, advanceAmount, paidAmount = 0) {
  let subtotal = 0;
  let tax = 0;
  for (const item of items) {
    const line = calcLine(item);
    subtotal += line.taxable;
    tax += line.tax;
  }
  const discount = Math.max(0, num(orderDiscount));
  const grandTotal = Math.max(0, subtotal - discount + tax);
  const remainingAmount = Math.max(0, grandTotal - Math.max(0, num(advanceAmount)) - Math.max(0, num(paidAmount)));
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
    workDate: row.workDate || row.completedAt,
    notes: row.notes || '',
    fromStage: row.fromStage || '',
    pickedLotName: row.pickedLotName || '',
    vehicleNumber: row.vehicleNumber || '',
    handoverPerson: row.handoverPerson || '',
    deliveryPartner: row.deliveryPartner || '',
    details: row.details && typeof row.details === 'object' ? { ...row.details } : {},
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

const EMPTY_IMAGE = {
  originalName: '',
  mimeType: '',
  dataUrl: '',
  url: '',
  key: '',
  storage: '',
};

function normalizeImage(source, { strict = false } = {}) {
  const imageSource = source || {};
  const image = {
    originalName: str(imageSource.originalName),
    mimeType: str(imageSource.mimeType),
    dataUrl: typeof imageSource.dataUrl === 'string' ? imageSource.dataUrl : '',
    url: str(imageSource.url),
    key: str(imageSource.key),
    storage: str(imageSource.storage),
  };
  if (!image.url && !image.dataUrl && !image.key && !image.originalName) return null;
  if (!['', 'local', 's3'].includes(image.storage)) image.storage = '';
  if (image.url) {
    image.dataUrl = '';
  } else if (image.dataUrl.length > 2_500_000) {
    if (strict) {
      throw new ApiError(400, 'Product image is too large (max about 2 MB). Configure S3 and upload via /api/media.');
    }
    return null;
  }
  return image;
}

function normalizeImages(raw, { strict = false } = {}) {
  const incoming = Array.isArray(raw?.images) ? raw.images : [];
  const images = incoming.map((item) => normalizeImage(item, { strict })).filter(Boolean);
  if (!images.length) {
    const single = normalizeImage(raw?.image, { strict });
    if (single) images.push(single);
  }
  if (strict && images.length > 20) {
    throw new ApiError(400, 'A product can have at most 20 images.');
  }
  return images.slice(0, 20);
}

function rollingFor(item) {
  return rateCalculator.rolling({
    width: item.width || item.manufacturing?.width,
    length: item.length || item.manufacturing?.length,
    gauge: item.thickness || item.manufacturing?.thickness,
    materialRate: item.manufacturing?.materialRate,
    quantity: item.quantity,
    unit: item.unit,
  });
}

function toPublicItem(item) {
  return {
    id: String(item._id),
    product: item.product || '',
    productCode: item.productCode || '',
    productType: item.productType || '',
    templateId: item.templateId || '',
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
      materialRate: item.manufacturing?.materialRate || '',
      width: item.manufacturing?.width || '',
      length: item.manufacturing?.length || '',
      thickness: item.manufacturing?.thickness || '',
      color: item.manufacturing?.color || '',
      additives: item.manufacturing?.additives || '',
      specialRequirements: item.manufacturing?.specialRequirements || '',
    },
    rolling: rollingFor(item),
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
      specialRequirements: item.printing?.specialRequirements || '',
    },
    holes: {
      required: Boolean(item.holes?.required),
      count: item.holes?.count || '',
      type: item.holes?.type || '',
      size: item.holes?.size || '',
      position: item.holes?.position || '',
      specialRequirements: item.holes?.specialRequirements || '',
    },
    tape: {
      required: Boolean(item.tape?.required),
      type: item.tape?.type || '',
    },
    image: normalizeImages(item)[0] || { ...EMPTY_IMAGE },
    images: normalizeImages(item),
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
    url: attachment.url || '',
    key: attachment.key || attachment.storedName || '',
    storage: attachment.storage || 'local',
    uploadedBy: toPublicUser(attachment.uploadedBy),
    createdAt: attachment.createdAt,
  };
}

function toPublicOrder(order) {
  const items = (order.items || []).map((item) => ({
    ...toPublicItem(item),
    progress: itemProgress(item, order.status),
    stageStats: Object.fromEntries(routeStages(item.productionRoute).map((stage) => [stage, stageStats(item, stage)])),
  }));

  return {
    id: String(order._id),
    number: order.number,
    orderType: order.orderType || ORDER_TYPES.SALES_ORDER,
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
    paidAmount: order.paidAmount || 0,
    payments: (order.payments || []).map((payment) => ({
      id: String(payment._id),
      amount: payment.amount,
      method: payment.method,
      reference: payment.reference || '',
      note: payment.note || '',
      receivedAt: payment.receivedAt,
      byName: payment.byName || '',
    })),
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
    nextStatus:
      {
        [SALES_ORDER_STATUSES.DRAFT]: SALES_ORDER_STATUSES.SUBMITTED,
        [SALES_ORDER_STATUSES.SUBMITTED]: SALES_ORDER_STATUSES.APPROVED,
        [SALES_ORDER_STATUSES.APPROVED]: SALES_ORDER_STATUSES.PRODUCTION_PLANNED,
        [SALES_ORDER_STATUSES.DELIVERED]: SALES_ORDER_STATUSES.COMPLETED,
      }[order.status] || null,
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
  delete next.paidAmount;
  delete next.payments;
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
    if (copy.manufacturing) {
      copy.manufacturing = { ...copy.manufacturing };
      delete copy.manufacturing.materialRate;
    }
    if (copy.rolling) {
      copy.rolling = { ...copy.rolling };
      delete copy.rolling.materialPer1000;
      delete copy.rolling.totalMaterial;
    }
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
        stageStats: published.stageStats || {},
        stageWork: (published.stageWork || []).filter((row) => stations.includes(row.stage)),
        requirements: views,
      };
    })
    .filter(Boolean);

  const showDispatch = stations.includes('dispatch');
  return {
    id: publicOrder.id,
    number: publicOrder.number,
    orderType: publicOrder.orderType,
    status: publicOrder.status,
    priority: publicOrder.priority,
    orderDate: publicOrder.orderDate,
    deliveryDate: publicOrder.deliveryDate,
    viewMode: 'stage',
    viewStages: stations,
    customer: {
      name: showDispatch ? publicOrder.customer?.name || '' : '',
      code: publicOrder.customer?.code || '',
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

function productSize(width, length) {
  const size = combinedSize(width, length);
  const plain = /^\d+(\.\d+)?$/;
  return plain.test(str(width)) && plain.test(str(length)) ? `${size} inch` : size;
}

function impressionColours(impressions) {
  const match = str(impressions).match(/\d+(?:\s*\+\s*\d+)+/);
  if (!match) return 0;
  return match[0].split('+').reduce((sum, part) => sum + Number(part), 0);
}

// Specs entered once on the product are copied to every stage that reads them.
function shareProductSpecs(item) {
  const { manufacturing, bag, roll, printing, holes } = item;
  item.material = item.material || manufacturing.rawMaterial;
  manufacturing.rawMaterial = item.material;
  printing.artwork = printing.artwork || printing.requirement;
  printing.requirement = '';
  const colours = impressionColours(printing.impressions);
  printing.colorCount = colours ? String(colours) : '';
  const special = manufacturing.specialRequirements || printing.specialRequirements || holes.specialRequirements;
  manufacturing.specialRequirements = special;
  printing.specialRequirements = special;
  holes.specialRequirements = special;
  item.width = item.width || manufacturing.width || bag.width;
  item.length = item.length || manufacturing.length || bag.length;
  item.thickness = item.thickness || manufacturing.thickness;
  item.color = item.color || manufacturing.color;
  if (item.width || item.length) item.size = productSize(item.width, item.length);
  manufacturing.width = item.width;
  manufacturing.length = item.length;
  manufacturing.thickness = item.thickness;
  manufacturing.color = item.color;
  if (item.quantity > 0) manufacturing.requiredQuantity = `${item.quantity} ${item.unit}`.trim();
  bag.width = item.width;
  bag.length = item.length;
  bag.size = productSize(bag.width, bag.length) || item.size;
  if (!roll.width) roll.width = item.width;
  roll.size = combinedSize(roll.width, roll.length);
  clearUnusedStages(item);
}

function clearUnusedStages(item) {
  const stages = routeStages(item.productionRoute);
  if (stages[0] !== 'rolling') {
    Object.assign(item.manufacturing, { materialType: '', materialGrade: '', requiredWeight: '', materialRate: '', additives: '' });
    Object.assign(item.roll, { width: '', length: '', weight: '', size: '' });
  }
  if (!stages.includes('printing')) {
    Object.assign(item.printing, { required: false, artwork: '', impressions: '', colorCount: '', colors: '', design: '' });
  }
  if (!stages.includes('cutting')) {
    item.bag.gusset = '';
    Object.assign(item.holes, { required: false, count: '', type: '', size: '', position: '' });
    Object.assign(item.tape, { required: false, type: '' });
  }
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
    'materialRate',
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
    ...normalizeGroup(printingSource, [
      'artwork',
      'impressions',
      'colorCount',
      'colors',
      'design',
      'requirement',
      'specialRequirements',
    ]),
  };

  const holesSource = raw.holes || {};
  const holes = {
    required: bool(holesSource.required),
    ...normalizeGroup(holesSource, ['count', 'type', 'size', 'position', 'specialRequirements']),
  };

  const tapeSource = raw.tape || {};
  const tape = {
    required: bool(tapeSource.required),
    type: str(tapeSource.type),
  };

  const images = normalizeImages(raw, { strict: true });
  const image = images[0] || { ...EMPTY_IMAGE };

  const item = {
    product: str(raw.product),
    productCode: str(raw.productCode),
    productType: str(raw.productType),
    templateId: str(raw.templateId),
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
    image,
    images,
    currentStage: '',
    stageWork: [],
  };
  if (item.quantity < 0) throw new ApiError(400, 'Quantity cannot be negative');
  if (item.rate < 0) throw new ApiError(400, 'Rate cannot be negative');
  if (item.taxPercent < 0 || item.taxPercent > 100) throw new ApiError(400, 'Tax must be between 0 and 100 percent');
  if (item.discount < 0) throw new ApiError(400, 'Line discount cannot be negative');
  if (item.discount > item.quantity * item.rate + 1e-6) {
    throw new ApiError(400, `Line discount on ${item.product || 'a product'} is more than its value`);
  }
  item.amount = calcLine(item).amount;
  shareProductSpecs(item);
  const rolling = rollingFor(item);
  if (routeStages(productionRoute)[0] === 'rolling' && rolling.totalWeight > 0) item.manufacturing.requiredWeight = String(rolling.totalWeight);
  const rawId = raw._id || raw.id;
  if (rawId && mongoose.isValidObjectId(rawId)) item._id = rawId;
  return item;
}

function normalizeItems(rawItems, orderType = ORDER_TYPES.SALES_ORDER) {
  if (!Array.isArray(rawItems)) throw new ApiError(400, 'Items must be a list of products');
  const seen = new Set();
  const blank = (raw) =>
    !str(raw?.product) && !str(raw?.productCode) && !(num(raw?.quantity) > 0) && !(raw?.stageWork || []).length;
  return rawItems.filter((raw) => !blank(raw)).map((raw) => {
    const item = normalizeItem(raw);
    if (ROUTE_BY_ID.get(item.productionRoute)?.orderType !== orderType) {
      throw new ApiError(
        400,
        orderType === ORDER_TYPES.JOB_WORK
          ? `${item.product || 'A product'} needs a job work route: Printing → Dispatch, Printing → Cutting → Dispatch, or Cutting → Dispatch`
          : `${item.product || 'A product'} needs a sales order route that starts at Rolling`
      );
    }
    const key = item._id ? String(item._id) : '';
    if (key && seen.has(key)) delete item._id;
    if (key) seen.add(key);
    return item;
  });
}

function assertOrderNumbers(doc) {
  if (doc.orderDate && doc.deliveryDate && new Date(doc.deliveryDate) < new Date(new Date(doc.orderDate).toDateString())) {
    throw new ApiError(400, 'Delivery date cannot be before the order date');
  }
  const subtotal = (doc.items || []).reduce((sum, item) => sum + calcLine(item).taxable, 0);
  if (num(doc.discount) > subtotal + 1e-6) {
    throw new ApiError(400, 'Order discount cannot be more than the subtotal');
  }
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
  const totals = calcTotals(items, discount, advanceAmount, doc.paidAmount);
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

// Lists every gap at once so the order can be fixed in one pass.
function assertReadyToSubmit(order) {
  const problems = [];
  if (!order.deliveryDate) problems.push('Delivery date is required before submit');
  if (!order.items.length) problems.push('Add at least one product before submit');
  order.items.forEach((item, index) => {
    const missing = [];
    if (!item.product) missing.push('product name');
    if (!item.productCode) missing.push('product code');
    if (!item.productType) missing.push('product type');
    if (!str(item.width) || !str(item.length)) missing.push('width and length');
    if (!item.material) missing.push('material');
    if (!item.quantity) missing.push('quantity');
    if (!item.unit) missing.push('unit');
    if (
      routeStages(item.productionRoute)[0] === 'rolling' &&
      String(item.unit || '').toLowerCase() !== 'kg' &&
      !(Number(String(item.manufacturing?.requiredWeight || '').replace(/,/g, '').match(/\d+(\.\d+)?/)?.[0]) > 0)
    ) {
      missing.push('required weight (kg), so rolling knows when it is finished');
    }
    if (routeHasPrint(item.productionRoute) && !item.printing?.colorCount && !item.printing?.colors) {
      missing.push('an impression (like 1+1) or printing colours');
    }
    if (item.rate < 0) missing.push('a valid rate');
    if (missing.length) problems.push(`Line ${index + 1} (${item.product || 'unnamed'}) needs ${missing.join(', ')}`);
  });
  if (problems.length) throw new ApiError(400, problems.join('\n'));
}

async function getOrderOrThrow(id) {
  const order = await salesOrderRepo.findById(id);
  if (!order) {
    throw new ApiError(404, 'Order not found');
  }
  return order;
}

async function presentAfterSync(order, user, taskOptions) {
  const loaded = await salesOrderRepo.findById(order._id);
  await taskHooks.syncOrder(loaded, user, taskOptions);
  return present(loaded, user);
}

function requireDraft(order) {
  if (order.status !== SALES_ORDER_STATUSES.DRAFT) {
    throw new ApiError(400, 'Only draft orders can be edited');
  }
}

async function listOrders(user) {
  const orders = await salesOrderRepo.findAll();
  if (operatorStations(user).length) {
    return orders
      .filter((order) => !HIDDEN_FROM_OPERATORS.includes(order.status))
      .map((order) => present(order, user))
      .filter((view) => view.items.length);
  }
  return orders.map((order) => present(order, user));
}

function assertNotOverpaid(order) {
  const received = (Number(order.advanceAmount) || 0) + (Number(order.paidAmount) || 0);
  if (received > (Number(order.grandTotal) || 0) + 0.001) {
    throw new ApiError(
      400,
      `Advance and payments received (${roundMoney(received)}) cannot be more than the order total (${roundMoney(order.grandTotal)})`
    );
  }
}

const HIDDEN_FROM_OPERATORS = [
  SALES_ORDER_STATUSES.DRAFT,
  SALES_ORDER_STATUSES.SUBMITTED,
  SALES_ORDER_STATUSES.APPROVED,
  SALES_ORDER_STATUSES.CANCELLED,
];

async function getOrder(user, id) {
  const order = await getOrderOrThrow(id);
  if (operatorStations(user).length) {
    const view = HIDDEN_FROM_OPERATORS.includes(order.status) ? null : present(order, user);
    if (!view || !view.items.length) throw new ApiError(404, 'Order not found');
    return view;
  }
  return present(order, user);
}

async function createOrder(user, payload) {
  const customer = await loadCustomer(payload.customerId);
  const snapshot = snapshotFromCustomer(customer);
  const orderType = payload.orderType || ORDER_TYPES.SALES_ORDER;
  assertIn(orderType, ORDER_TYPES, 'Order type must be Sales order or Job work');
  const items = normalizeItems(payload.items || [], orderType);
  assertDraftComplete(items);

  const orderDate = parseDate(payload.orderDate || new Date(), 'Order date', { required: true });
  const doc = {
    orderType,
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

  doc.items = items;
  doc.discount = Math.max(0, num(payload.discount));
  assertOrderNumbers(doc);
  applyTotals(doc, items, payload.discount, doc.advanceAmount);
  assertNotOverpaid(doc);
  assertIn(doc.priority, ORDER_PRIORITIES, 'Priority must be normal, high, or urgent');
  assertIn(doc.paymentTerms, PAYMENT_TERMS, 'Invalid payment terms');
  assertIn(doc.paymentMethod, PAYMENT_METHODS, 'Invalid payment method');
  doc.number = await nextSalesOrderNumber(orderDate, orderType);
  const created = await salesOrderRepo.create(doc);
  await rememberProducts(customer._id, payload.items, items);
  const loaded = await salesOrderRepo.findById(created._id);
  await taskHooks.syncOrder(loaded, user);
  return present(loaded, user);
}

async function updateOrder(user, id, payload) {
  const order = await getOrderOrThrow(id);
  requireDraft(order);

  let snapshot = order.customerSnapshot;
  if (payload.customerId && String(payload.customerId) !== String(order.customer?._id || order.customer)) {
    const customer = await loadCustomer(payload.customerId);
    snapshot = snapshotFromCustomer(customer);
    order.customer = customer._id;
    order.customerSnapshot = snapshot;
  }

  applyHeader(order, payload, snapshot);
  const orderType = order.orderType || ORDER_TYPES.SALES_ORDER;
  const items =
    payload.items !== undefined
      ? normalizeItems(payload.items, orderType)
      : normalizeItems(order.items.map((item) => item.toObject()), orderType);
  assertDraftComplete(items);
  assertOrderNumbers({ orderDate: order.orderDate, deliveryDate: order.deliveryDate, items, discount: order.discount });
  applyTotals(order, items, payload.discount !== undefined ? payload.discount : order.discount, order.advanceAmount);
  assertNotOverpaid(order);

  await salesOrderRepo.save(order);
  await rememberProducts(order.customer, payload.items || [], items);
  return presentAfterSync(order, user);
}

async function rememberProducts(customerId, rawItems, items) {
  try {
    await attachProductsFromOrder(customerId, items);
    await require('../salesSettings/salesSettings.service').ensureTemplatesFromItems(rawItems, items);
  } catch (error) {
    console.error('Saving products and list options after the order failed', error.message);
  }
}

async function deleteOrder(id) {
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.DRAFT) {
    throw new ApiError(400, 'Only draft orders can be deleted');
  }
  if ((order.payments || []).length) {
    throw new ApiError(400, 'This order has payments recorded. Remove them or cancel the order instead of deleting it');
  }
  if (await require('../inventory/item.repo').countOrderMaterial(order._id)) {
    throw new ApiError(400, 'Customer material in inventory is linked to this order. Unlink it or cancel the order instead');
  }
  for (const attachment of order.attachments || []) {
    await deleteStoredObject(attachment.key || attachment.storedName, attachment.storage || 'local').catch(() => {});
  }
  await salesOrderRepo.deleteById(id);
  await taskHooks.removeForOrder(id);
  await fs.rm(path.join(env.uploadsDir, 'sales-orders', String(id)), { recursive: true, force: true }).catch(() => {});
}

async function submitOrder(user, id) {
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.DRAFT) {
    throw new ApiError(400, 'Only draft orders can be submitted');
  }
  assertReadyToSubmit(order);
  order.status = SALES_ORDER_STATUSES.SUBMITTED;
  order.submittedAt = new Date();
  await salesOrderRepo.save(order);
  await attachProductsFromOrder(order.customer?._id || order.customer, order.items, { refresh: true }).catch((error) =>
    console.error('Updating customer products after submit failed', error.message)
  );
  return presentAfterSync(order, user);
}

async function approveOrder(user, id) {
  if (!isSuperAdmin(user)) {
    throw new ApiError(403, 'Only Super Admin can approve an order');
  }
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.SUBMITTED) {
    throw new ApiError(400, 'Only submitted orders can be approved');
  }
  order.status = SALES_ORDER_STATUSES.APPROVED;
  order.approvedAt = new Date();
  await salesOrderRepo.save(order);
  return presentAfterSync(order, user);
}

async function returnToDraft(user, id, reason) {
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.SUBMITTED && order.status !== SALES_ORDER_STATUSES.APPROVED) {
    throw new ApiError(400, 'Only submitted or approved orders can go back to draft');
  }
  if (order.status === SALES_ORDER_STATUSES.APPROVED && !isSuperAdmin(user)) {
    throw new ApiError(403, 'Only Super Admin can send an approved order back to draft');
  }
  if (!isSuperAdmin(user) && !hasPermission(user, 'sales:update')) {
    throw new ApiError(403, 'You cannot send this order back to draft');
  }
  order.status = SALES_ORDER_STATUSES.DRAFT;
  order.submittedAt = null;
  order.approvedAt = null;
  const note = str(reason);
  if (note) order.remarks = [order.remarks, `Sent back: ${note}`].filter(Boolean).join('\n');
  await salesOrderRepo.save(order);
  return presentAfterSync(order, user, { returned: true, reason: note });
}

async function planProduction(user, id) {
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.APPROVED) {
    throw new ApiError(400, 'Only approved orders can be planned for production');
  }
  for (const item of order.items || []) {
    item.currentStage = firstStage(item.productionRoute);
    item.stageWork = [];
    item.stagePickup = {
      stage: '',
      fromStage: '',
      lot: null,
      lotName: '',
      qty: 0,
      unit: '',
      pickedBy: null,
      pickedByName: '',
      pickedAt: null,
    };
  }
  order.status = SALES_ORDER_STATUSES.PRODUCTION_PLANNED;
  order.productionPlannedAt = new Date();
  await salesOrderRepo.save(order);
  await require('../register/register.service').openForOrder(order);
  return presentAfterSync(order, user);
}

async function advanceOrder(user, id) {
  const order = await getOrderOrThrow(id);
  if (order.status !== SALES_ORDER_STATUSES.DELIVERED) {
    throw new ApiError(400, 'Operators send goods from the Dispatch stage. Only a fully dispatched order can be marked completed here.');
  }
  order.status = SALES_ORDER_STATUSES.COMPLETED;
  order.completedAt = order.completedAt || new Date();
  await salesOrderRepo.save(order);
  await require('../inventory/item.repo')
    .retireOrderLots(order._id, `order ${order.number} completed`)
    .catch((error) => console.error('Retiring floor lots after completion failed', error.message));
  return presentAfterSync(order, user);
}

async function cancelOrder(user, id, reason) {
  const order = await getOrderOrThrow(id);
  if (order.status === SALES_ORDER_STATUSES.CANCELLED) {
    throw new ApiError(400, 'Order is already cancelled');
  }
  const shipped = [SALES_ORDER_STATUSES.DISPATCHED, SALES_ORDER_STATUSES.DELIVERED, SALES_ORDER_STATUSES.COMPLETED];
  if (shipped.includes(order.status)) {
    throw new ApiError(400, 'Goods have already gone out on this order, so it cannot be cancelled');
  }
  const anyDispatch = (order.items || []).some((item) => (item.stageWork || []).some((row) => row.stage === 'dispatch'));
  if (anyDispatch) {
    throw new ApiError(400, 'Part of this order is already dispatched, so it cannot be cancelled');
  }

  const early = [SALES_ORDER_STATUSES.DRAFT, SALES_ORDER_STATUSES.SUBMITTED, SALES_ORDER_STATUSES.APPROVED].includes(order.status);
  const salesCan = hasPermission(user, 'sales:update');
  const productionCan = hasPermission(user, 'production:update');

  if (early && !salesCan && !isSuperAdmin(user)) {
    throw new ApiError(403, 'You cannot cancel this order');
  }
  if (!early && !productionCan && !isSuperAdmin(user)) {
    throw new ApiError(403, 'Once production is planned, only Production Manager or Super Admin can cancel');
  }

  if (!early) {
    await require('../production/production.service').releaseOrderStock(order);
  }
  await require('../inventory/item.repo')
    .noteOrderMaterial(order._id, `order ${order.number} cancelled - return to customer`)
    .catch((error) => console.error('Marking customer material after cancel failed', error.message));
  order.status = SALES_ORDER_STATUSES.CANCELLED;
  order.cancelledAt = new Date();
  order.cancelledBy = user._id;
  order.cancellationReason = str(reason);
  await salesOrderRepo.save(order);
  return presentAfterSync(order, user, { reason: order.cancellationReason });
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
    throw new ApiError(403, 'You cannot attach files to this order');
  }

  const attachmentKind = str(kind) || ATTACHMENT_KINDS.OTHER;
  if (!Object.values(ATTACHMENT_KINDS).includes(attachmentKind)) {
    throw new ApiError(400, 'Invalid attachment type');
  }

  const uploaded = await uploadBuffer({
    buffer: file.buffer,
    originalName: file.originalname,
    mimeType: file.mimetype,
    folder: `sales-orders/${id}`,
  });

  order.attachments.push({
    originalName: uploaded.originalName,
    storedName: uploaded.key,
    key: uploaded.key,
    url: uploaded.url,
    storage: uploaded.storage,
    mimeType: uploaded.mimeType,
    size: uploaded.size,
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
  await deleteStoredObject(attachment.key || attachment.storedName, attachment.storage || 'local');
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

  if (attachment.url && (attachment.storage === 's3' || String(attachment.url).startsWith('http'))) {
    return {
      redirectUrl: attachment.url,
      originalName: attachment.originalName,
      mimeType: attachment.mimeType,
    };
  }

  const key = attachment.key || attachment.storedName;
  const filePath = path.isAbsolute(key) ? key : path.join(env.uploadsDir, key);
  try {
    await fs.access(filePath);
  } catch {
    // Legacy path layout
    const legacy = path.join(attachmentDir(id), attachment.storedName);
    try {
      await fs.access(legacy);
      return { filePath: legacy, originalName: attachment.originalName, mimeType: attachment.mimeType };
    } catch {
      throw new ApiError(404, 'File is missing');
    }
  }
  return { filePath, originalName: attachment.originalName, mimeType: attachment.mimeType };
}

const NO_PAYMENT_STATUSES = [SALES_ORDER_STATUSES.DRAFT, SALES_ORDER_STATUSES.CANCELLED];

function canRecordPayment(user) {
  return (
    isSuperAdmin(user) ||
    hasPermission(user, 'accounts:create') ||
    hasPermission(user, 'accounts:update') ||
    hasPermission(user, 'sales:update')
  );
}

function refreshBalance(order) {
  order.paidAmount = roundMoney((order.payments || []).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0));
  order.remainingAmount = roundMoney(
    Math.max(0, (Number(order.grandTotal) || 0) - (Number(order.advanceAmount) || 0) - order.paidAmount)
  );
}

async function recordPayment(user, id, payload = {}) {
  if (!canRecordPayment(user)) throw new ApiError(403, 'You cannot record payments');
  const order = await getOrderOrThrow(id);
  if (NO_PAYMENT_STATUSES.includes(order.status)) {
    throw new ApiError(400, 'Payments can be recorded once the order is submitted, and not on a cancelled order');
  }
  const amount = roundMoney(num(payload.amount));
  if (!(amount > 0)) throw new ApiError(400, 'Amount must be more than 0');
  if (amount > roundMoney(order.remainingAmount) + 0.001) {
    throw new ApiError(400, `Amount cannot be more than the ${roundMoney(order.remainingAmount)} still due`);
  }
  const method = str(payload.method) || order.paymentMethod || PAYMENT_METHODS.BANK_TRANSFER;
  assertIn(method, PAYMENT_METHODS, 'Invalid payment method');
  const receivedAt = payload.receivedAt ? parseDate(payload.receivedAt, 'Received date') : new Date();
  if (receivedAt && receivedAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
    throw new ApiError(400, 'Received date cannot be in the future');
  }
  order.payments.push({
    amount,
    method,
    reference: str(payload.reference),
    note: str(payload.note),
    receivedAt: receivedAt || new Date(),
    by: user._id,
    byName: user.fullName || user.username || '',
  });
  refreshBalance(order);
  await salesOrderRepo.save(order);
  return presentAfterSync(order, user);
}

async function removePayment(user, id, paymentId) {
  if (!canRecordPayment(user)) throw new ApiError(403, 'You cannot change payments');
  const order = await getOrderOrThrow(id);
  if (order.status === SALES_ORDER_STATUSES.CANCELLED) {
    throw new ApiError(400, 'Payments on a cancelled order cannot be changed');
  }
  const payment = order.payments.id(paymentId);
  if (!payment) throw new ApiError(404, 'Payment not found');
  payment.deleteOne();
  refreshBalance(order);
  await salesOrderRepo.save(order);
  return presentAfterSync(order, user);
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
      byStatus[SALES_ORDER_STATUSES.READY_FOR_PACKING] +
      byStatus[SALES_ORDER_STATUSES.PACKED],
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
  returnToDraft,
  planProduction,
  advanceOrder,
  cancelOrder,
  addAttachment,
  removeAttachment,
  getAttachmentFile,
  recordPayment,
  removePayment,
  getSummary,
  getMeta,
  calcTotals,
  normalizeItem,
};
