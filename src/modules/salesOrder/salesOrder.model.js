const mongoose = require('mongoose');
const {
  ATTACHMENT_KINDS,
  ORDER_PRIORITIES,
  PAYMENT_METHODS,
  PAYMENT_TERMS,
  PRODUCTION_ROUTES,
  SALES_ORDER_STATUSES,
} = require('../../config/constants');

const lineItemSchema = new mongoose.Schema(
  {
    product: { type: String, default: '', trim: true },
    productCode: { type: String, default: '', trim: true },
    productType: { type: String, default: '', trim: true },
    size: { type: String, default: '', trim: true },
    material: { type: String, default: '', trim: true },
    thickness: { type: String, default: '', trim: true },
    width: { type: String, default: '', trim: true },
    length: { type: String, default: '', trim: true },
    color: { type: String, default: '', trim: true },
    quantity: { type: Number, default: 0, min: 0 },
    unit: { type: String, default: 'pcs', trim: true },
    rate: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    taxPercent: { type: Number, default: 0, min: 0 },
    amount: { type: Number, default: 0, min: 0 },
    productionRoute: {
      type: String,
      required: true,
      enum: Object.values(PRODUCTION_ROUTES),
    },
    manufacturing: {
      rawMaterial: { type: String, default: '', trim: true },
      materialType: { type: String, default: '', trim: true },
      materialGrade: { type: String, default: '', trim: true },
      requiredWeight: { type: String, default: '', trim: true },
      requiredQuantity: { type: String, default: '', trim: true },
      width: { type: String, default: '', trim: true },
      length: { type: String, default: '', trim: true },
      thickness: { type: String, default: '', trim: true },
      color: { type: String, default: '', trim: true },
      additives: { type: String, default: '', trim: true },
      specialRequirements: { type: String, default: '', trim: true },
    },
    roll: {
      width: { type: String, default: '', trim: true },
      length: { type: String, default: '', trim: true },
      weight: { type: String, default: '', trim: true },
      size: { type: String, default: '', trim: true },
    },
    bag: {
      width: { type: String, default: '', trim: true },
      length: { type: String, default: '', trim: true },
      gusset: { type: String, default: '', trim: true },
      size: { type: String, default: '', trim: true },
    },
    printing: {
      required: { type: Boolean, default: false },
      artwork: { type: String, default: '', trim: true },
      impressions: { type: String, default: '', trim: true },
      colorCount: { type: String, default: '', trim: true },
      colors: { type: String, default: '', trim: true },
      design: { type: String, default: '', trim: true },
      requirement: { type: String, default: '', trim: true },
      specialRequirements: { type: String, default: '', trim: true },
    },
    holes: {
      required: { type: Boolean, default: false },
      count: { type: String, default: '', trim: true },
      type: { type: String, default: '', trim: true },
      size: { type: String, default: '', trim: true },
      position: { type: String, default: '', trim: true },
      specialRequirements: { type: String, default: '', trim: true },
    },
    tape: {
      required: { type: Boolean, default: false },
      type: { type: String, default: '', trim: true },
    },
    image: {
      originalName: { type: String, default: '', trim: true },
      mimeType: { type: String, default: '', trim: true },
      dataUrl: { type: String, default: '' },
      url: { type: String, default: '', trim: true },
      key: { type: String, default: '', trim: true },
      storage: { type: String, enum: ['', 'local', 's3'], default: '' },
    },
    currentStage: { type: String, default: '', trim: true },
    stagePickup: {
      stage: { type: String, default: '', trim: true },
      fromStage: { type: String, default: '', trim: true },
      lot: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryItem', default: null },
      lotName: { type: String, default: '', trim: true },
      qty: { type: Number, default: 0, min: 0 },
      unit: { type: String, default: '', trim: true },
      pickedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      pickedByName: { type: String, default: '', trim: true },
      pickedAt: { type: Date, default: null },
    },
    stageWork: {
      type: [
        {
          stage: { type: String, required: true, trim: true },
          machine: { type: mongoose.Schema.Types.ObjectId, ref: 'Machine', default: null },
          machineName: { type: String, default: '', trim: true },
          operator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          operatorName: { type: String, default: '', trim: true },
          inputQty: { type: Number, default: 0, min: 0 },
          outputQty: { type: Number, default: 0, min: 0 },
          wasteQty: { type: Number, default: 0, min: 0 },
          shift: { type: String, default: 'morning', trim: true },
          workDate: { type: Date, default: Date.now },
          notes: { type: String, default: '', trim: true },
          fromStage: { type: String, default: '', trim: true },
          pickedLotName: { type: String, default: '', trim: true },
          vehicleNumber: { type: String, default: '', trim: true },
          handoverPerson: { type: String, default: '', trim: true },
          deliveryPartner: { type: String, default: '', trim: true },
          completedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  { _id: true }
);

const attachmentSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true, trim: true },
    storedName: { type: String, required: true, trim: true },
    key: { type: String, default: '', trim: true },
    url: { type: String, default: '', trim: true },
    storage: { type: String, enum: ['local', 's3'], default: 'local' },
    mimeType: { type: String, default: '', trim: true },
    size: { type: Number, default: 0 },
    kind: {
      type: String,
      enum: Object.values(ATTACHMENT_KINDS),
      default: ATTACHMENT_KINDS.OTHER,
    },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const customerSnapshotSchema = new mongoose.Schema(
  {
    code: { type: String, default: '' },
    name: { type: String, default: '' },
    companyName: { type: String, default: '' },
    contactPerson: { type: String, default: '' },
    mobile: { type: String, default: '' },
    email: { type: String, default: '' },
    gstNumber: { type: String, default: '' },
    billingAddress: { type: String, default: '' },
    shippingAddress: { type: String, default: '' },
    priceCategory: { type: String, default: '' },
  },
  { _id: false }
);

const salesOrderSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true, trim: true },
    orderDate: { type: Date, required: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerSnapshot: { type: customerSnapshotSchema, default: () => ({}) },
    deliveryDate: { type: Date, default: null },
    priority: {
      type: String,
      enum: Object.values(ORDER_PRIORITIES),
      default: ORDER_PRIORITIES.NORMAL,
    },
    status: {
      type: String,
      enum: Object.values(SALES_ORDER_STATUSES),
      default: SALES_ORDER_STATUSES.DRAFT,
    },
    paymentTerms: {
      type: String,
      enum: Object.values(PAYMENT_TERMS),
      default: PAYMENT_TERMS.CREDIT,
    },
    paymentMethod: {
      type: String,
      enum: Object.values(PAYMENT_METHODS),
      default: PAYMENT_METHODS.BANK_TRANSFER,
    },
    creditDays: { type: Number, default: 0, min: 0 },
    advanceAmount: { type: Number, default: 0, min: 0 },
    remainingAmount: { type: Number, default: 0, min: 0 },
    paymentRemarks: { type: String, default: '', trim: true },
    billingAddress: { type: String, default: '', trim: true },
    shippingAddress: { type: String, default: '', trim: true },
    deliveryLocation: { type: String, default: '', trim: true },
    deliveryInstructions: { type: String, default: '', trim: true },
    remarks: { type: String, default: '', trim: true },
    productionInstructions: { type: String, default: '', trim: true },
    items: { type: [lineItemSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    grandTotal: { type: Number, default: 0, min: 0 },
    attachments: { type: [attachmentSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    productionPlannedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    cancellationReason: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

salesOrderSchema.index({ status: 1, createdAt: -1 });
salesOrderSchema.index({ customer: 1 });

salesOrderSchema.set('toJSON', {
  transform(doc, ret) {
    ret.id = String(ret._id);
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('SalesOrder', salesOrderSchema);
