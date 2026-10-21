const { routeStages } = require('../production/production.flow');

// Every input the owner can make mandatory or optional, per form. `locked`
// inputs are always mandatory (the app cannot work without them). `when`
// limits a rule to lines it applies to (e.g. only lines that are printed).
// `get` reads the value from what is being saved.

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());
const firstNumber = (v) => Number(String(v ?? '').replace(/,/g, '').match(/\d+(\.\d+)?/)?.[0]) || 0;

const WHEN = {
  rolling: { label: 'only when the product goes through rolling', test: (item) => routeStages(item.productionRoute)[0] === 'rolling' },
  rollingPieces: {
    label: 'only when rolling makes a product sold in pieces (not kg)',
    test: (item) => routeStages(item.productionRoute)[0] === 'rolling' && text(item.unit).toLowerCase() !== 'kg',
  },
  printing: { label: 'only when the product is printed', test: (item) => routeStages(item.productionRoute).some((s) => s === 'printing') },
  cutting: { label: 'only when the product is cut into bags', test: (item) => routeStages(item.productionRoute).includes('cutting') },
  holes: { label: 'only when holes are needed', test: (item) => Boolean(item.holes?.required) },
  tape: { label: 'only when tape is needed', test: (item) => Boolean(item.tape?.required) },
};

const field = (key, label, get, extra = {}) => ({ key, label, get, default: false, locked: false, ...extra });

// Product lines are shared by orders and saved products.
const productFields = [
  field('productCode', 'Product code', (i) => i.productCode, { default: true }),
  field('productType', 'Product type', (i) => i.productType, { default: true }),
  field('width', 'Width', (i) => i.width, { default: true }),
  field('length', 'Length', (i) => i.length, { default: true }),
  field('flap', 'Flap', (i) => i.flap),
  field('material', 'Material', (i) => i.material, { default: true }),
  field('thickness', 'Gauge', (i) => i.thickness),
  field('color', 'Colour', (i) => i.color),
  field('hsnCode', 'HSN code', (i) => i.hsnCode),
  field('rate', 'Rate (more than 0)', (i) => (Number(i.rate) > 0 ? i.rate : '')),
  field('requiredWeight', 'Required weight (kg) for rolling', (i) => (firstNumber(i.manufacturing?.requiredWeight) > 0 ? i.manufacturing.requiredWeight : ''), { default: true, when: 'rollingPieces' }),
  field('materialType', 'Material type', (i) => i.manufacturing?.materialType, { when: 'rolling' }),
  field('materialGrade', 'Material grade', (i) => i.manufacturing?.materialGrade, { when: 'rolling' }),
  field('materialRate', 'Material rate (₹ / kg)', (i) => i.manufacturing?.materialRate, { when: 'rolling' }),
  field('additives', 'Additives', (i) => i.manufacturing?.additives, { when: 'rolling' }),
  field('rollWidth', 'Roll width', (i) => i.roll?.width, { when: 'rolling' }),
  field('rollLength', 'Roll length', (i) => i.roll?.length, { when: 'rolling' }),
  field('rollWeight', 'Roll weight', (i) => i.roll?.weight, { when: 'rolling' }),
  field('printColours', 'Impression or printing colours', (i) => i.printing?.colorCount || i.printing?.colors, { default: true, when: 'printing' }),
  field('printDesign', 'Printing design', (i) => i.printing?.design, { when: 'printing' }),
  field('gusset', 'Gusset', (i) => i.bag?.gusset, { when: 'cutting' }),
  field('holeCount', 'No. of holes', (i) => i.holes?.count, { when: 'holes' }),
  field('holeType', 'Hole type', (i) => i.holes?.type, { when: 'holes' }),
  field('holeSize', 'Hole size', (i) => i.holes?.size, { when: 'holes' }),
  field('holePosition', 'Hole position', (i) => i.holes?.position, { when: 'holes' }),
  field('tapeType', 'Tape type', (i) => i.tape?.type, { when: 'tape' }),
  field('specialRequirements', 'Special requirements', (i) => i.manufacturing?.specialRequirements),
];

const FORMS = [
  {
    id: 'order',
    label: 'Order (sales order and job work)',
    checkedOn: 'Checked when the order is submitted; a draft can be saved half-filled.',
    fields: [
      field('customer', 'Customer', (o) => o.customer, { locked: true }),
      field('orderDate', 'Order date', (o) => o.orderDate, { locked: true }),
      field('deliveryDate', 'Delivery date', (o) => o.deliveryDate, { default: true }),
      field('customerPoNumber', 'Customer PO no.', (o) => o.customerPoNumber),
      field('customerPoDate', 'PO date', (o) => o.customerPoDate),
      field('billingAddress', 'Billing address', (o) => o.billingAddress),
      field('shippingAddress', 'Shipping address', (o) => o.shippingAddress),
      field('deliveryLocation', 'Delivery location', (o) => o.deliveryLocation),
      field('deliveryInstructions', 'Delivery instructions', (o) => o.deliveryInstructions),
      field('paymentRemarks', 'Payment remarks', (o) => o.paymentRemarks),
      field('remarks', 'Remarks', (o) => o.remarks),
      field('productionInstructions', 'Production instructions', (o) => o.productionInstructions),
    ],
  },
  {
    id: 'orderLine',
    label: 'Order products (every line)',
    checkedOn: 'Checked when the order is submitted.',
    fields: [
      field('product', 'Product', (i) => i.product, { locked: true }),
      field('productionRoute', 'Production flow', (i) => i.productionRoute, { locked: true }),
      field('quantity', 'Quantity', (i) => (Number(i.quantity) > 0 ? i.quantity : ''), { locked: true }),
      field('unit', 'Unit', (i) => i.unit, { locked: true }),
      ...productFields,
    ],
  },
  {
    id: 'template',
    label: 'Saved product (Product setup)',
    checkedOn: 'Checked when the product is saved.',
    fields: [field('name', 'Name', (t) => t.name, { locked: true }), field('productionRoute', 'Production flow', (t) => t.productionRoute, { locked: true }), field('unit', 'Unit', (t) => t.unit), ...productFields.map((f) => ({ ...f, default: false }))],
  },
  {
    id: 'customer',
    label: 'Customer',
    checkedOn: 'Checked when the customer is saved.',
    fields: [
      field('name', 'Customer name', (c) => c.name, { locked: true }),
      field('companyName', 'Company', (c) => c.companyName),
      field('contactPerson', 'Contact person', (c) => c.contactPerson),
      field('mobile', 'Mobile', (c) => c.mobile),
      field('email', 'Email', (c) => c.email),
      field('gstNumber', 'GST number', (c) => c.gstNumber),
      field('billingAddress', 'Billing address', (c) => c.billingAddress),
      field('shippingAddress', 'Shipping address', (c) => c.shippingAddress),
      field('priceCategory', 'Price category', (c) => c.priceCategory),
    ],
  },
  {
    id: 'supplier',
    label: 'Supplier',
    checkedOn: 'Checked when the supplier is saved.',
    fields: [
      field('name', 'Supplier name', (s) => s.name, { locked: true }),
      field('gstNumber', 'GST number', (s) => s.gstNumber),
      field('contactPerson', 'Contact person', (s) => s.contactPerson),
      field('mobile', 'Mobile', (s) => s.mobile),
      field('email', 'Email', (s) => s.email),
      field('address', 'Address', (s) => s.address),
      field('materials', 'Materials supplied', (s) => s.materials),
    ],
  },
];
const FORM_BY_ID = new Map(FORMS.map((f) => [f.id, f]));

module.exports = { FORMS, FORM_BY_ID, WHEN, text };
