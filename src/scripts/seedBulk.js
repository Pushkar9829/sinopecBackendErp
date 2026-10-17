// Load-testing data for a LOCAL database: the normal demo seed, then many
// more customers, orders, stock lots and draft orders built from it.
//
//   ALLOW_DESTRUCTIVE_SEED=1 MONGODB_URI=mongodb://127.0.0.1:27017/sinopec_dev node src/scripts/seedBulk.js
//
// Like `npm run seed` it WIPES the business data of that database first, and
// it refuses anything that is not a localhost MongoDB. Sizes can be changed
// with BULK_CUSTOMERS, BULK_ORDERS, BULK_LOTS and BULK_DRAFTS.
require('../config/env');
const mongoose = require('mongoose');
const { connectDb } = require('../config/db');
const { seed, resetDemoCollections, assertDestructiveSeedAllowed } = require('../seeders/seed');
const { syncOrder } = require('../modules/task/task.hooks');
const reviewTasks = require('../modules/intake/intake.tasks');
const Intake = require('../modules/intake/intake.model');

const COUNTS = {
  customers: Number(process.env.BULK_CUSTOMERS) || 500,
  orders: Number(process.env.BULK_ORDERS) || 3000,
  lots: Number(process.env.BULK_LOTS) || 800,
  drafts: Number(process.env.BULK_DRAFTS) || 400,
};

const DAY = 24 * 60 * 60 * 1000;
const FIRST = ['Shree', 'Om', 'Sai', 'Balaji', 'Ganesh', 'Krishna', 'Laxmi', 'Durga', 'Sunrise', 'Star', 'Royal', 'Metro', 'Prime', 'Global', 'Classic'];
const LAST = ['Packaging', 'Plastics', 'Polymers', 'Traders', 'Industries', 'Enterprises', 'Foods', 'Garments', 'Pharma', 'Retail'];
const CITIES = ['Pune', 'Mumbai', 'Ahmedabad', 'Surat', 'Delhi', 'Jaipur', 'Indore', 'Nagpur', 'Nashik', 'Vadodara'];
const PRODUCTS = ['Polly bag', 'Printed pouch', 'Courier bag', 'Garbage bag', 'Carry bag', 'Zip lock bag', 'Shrink roll', 'Liner bag'];

let seedValue = 42;
function rand() {
  seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
  return seedValue / 2147483648;
}
const pick = (list) => list[Math.floor(rand() * list.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pad = (n, size = 5) => String(n).padStart(size, '0');
const id = () => new mongoose.Types.ObjectId();
const strip = ({ _id, ...rest }) => rest;

async function bulkCustomers(db) {
  const base = await db.collection('customers').find({}).toArray();
  const docs = [];
  for (let i = 0; i < COUNTS.customers; i += 1) {
    const src = base[i % base.length];
    const name = `${pick(FIRST)} ${pick(LAST)} ${i + 1}`;
    const city = pick(CITIES);
    const mobile = `9${pad(700000000 + i, 9)}`;
    docs.push({
      ...strip(src),
      code: `CUST-${pad(1000 + i)}`,
      name,
      companyName: `${name} Pvt Ltd`,
      contactPerson: `${pick(['Raj', 'Amit', 'Priya', 'Neha', 'Vikram', 'Sunita'])} ${pick(['Shah', 'Patel', 'Mehta', 'Iyer', 'Rao'])}`,
      mobile,
      email: `buyer${i + 1}@example.test`,
      gstNumber: `27AAB${String.fromCharCode(65 + (i % 26))}${pad(i, 4)}A1Z${i % 10}`,
      billingAddress: `${int(1, 200)} Industrial Area, ${city}`,
      shippingAddress: `${int(1, 200)} Warehouse Road, ${city}`,
      products: (src.products || []).map((p) => ({ ...p, _id: id() })),
      isActive: rand() > 0.05,
      createdAt: new Date(Date.now() - int(30, 700) * DAY),
      updatedAt: new Date(),
    });
  }
  await db.collection('customers').insertMany(docs);
  await db.collection('counters').updateOne({ key: 'customer' }, { $set: { seq: 1000 + COUNTS.customers } }, { upsert: true });
  return db.collection('customers').find({}).toArray();
}

function snapshot(customer) {
  return {
    code: customer.code,
    name: customer.name,
    companyName: customer.companyName || '',
    contactPerson: customer.contactPerson || '',
    mobile: customer.mobile || '',
    email: customer.email || '',
    gstNumber: customer.gstNumber || '',
    billingAddress: customer.billingAddress || '',
    shippingAddress: customer.shippingAddress || '',
    priceCategory: customer.priceCategory || '',
  };
}

// Orders are copies of the demo orders (every status and route), moved to
// other customers and spread over the last year.
async function bulkOrders(db, customers) {
  const base = await db.collection('salesorders').find({}).toArray();
  const perYear = {};
  const docs = [];
  for (let i = 0; i < COUNTS.orders; i += 1) {
    const src = base[i % base.length];
    const customer = customers[int(0, customers.length - 1)];
    const orderDate = new Date(Date.now() - int(0, 365) * DAY);
    const year = orderDate.getFullYear();
    const type = src.orderType === 'job_work' ? 'JW' : 'SO';
    const counterKey = `${type === 'JW' ? 'jobWork' : 'salesOrder'}:${year}`;
    perYear[counterKey] = (perYear[counterKey] || 1000) + 1;
    const shift = orderDate.getTime() - new Date(src.orderDate || src.createdAt).getTime();
    const moved = (value) => (value ? new Date(new Date(value).getTime() + shift) : value);
    docs.push({
      ...strip(src),
      number: `${type}-${year}-${pad(perYear[counterKey])}`,
      customer: customer._id,
      customerSnapshot: snapshot(customer),
      billingAddress: customer.billingAddress,
      shippingAddress: customer.shippingAddress,
      orderDate,
      deliveryDate: moved(src.deliveryDate) || new Date(orderDate.getTime() + int(7, 30) * DAY),
      items: (src.items || []).map((item) => ({ ...item, _id: id(), product: item.product || pick(PRODUCTS) })),
      payments: (src.payments || []).map((p) => ({ ...p, _id: id(), receivedAt: moved(p.receivedAt) })),
      attachments: [],
      submittedAt: moved(src.submittedAt),
      approvedAt: moved(src.approvedAt),
      productionPlannedAt: moved(src.productionPlannedAt),
      completedAt: moved(src.completedAt),
      cancelledAt: moved(src.cancelledAt),
      createdAt: orderDate,
      updatedAt: orderDate,
    });
  }
  for (let i = 0; i < docs.length; i += 500) await db.collection('salesorders').insertMany(docs.slice(i, i + 500));
  for (const [key, seq] of Object.entries(perYear)) {
    await db.collection('counters').updateOne({ key }, { $max: { seq } }, { upsert: true });
  }
  return docs.length;
}

async function bulkLots(db) {
  const base = await db.collection('inventoryitems').find({ category: 'raw' }).toArray();
  if (!base.length) return 0;
  const docs = [];
  for (let i = 0; i < COUNTS.lots; i += 1) {
    const src = base[i % base.length];
    const received = new Date(Date.now() - int(0, 300) * DAY);
    docs.push({
      ...strip(src),
      name: `${src.name} lot ${i + 1}`,
      quantity: int(50, 5000),
      createdAt: received,
      updatedAt: received,
    });
  }
  for (let i = 0; i < docs.length; i += 500) await db.collection('inventoryitems').insertMany(docs.slice(i, i + 500));
  return docs.length;
}

const MESSAGES = [
  (q, p, w, l) => `Please share PI for ${q} pcs ${p} ${w}x${l}`,
  (q, p, w, l) => `Need ${q} ${p}, size ${w}*${l}, delivery next week`,
  (q, p) => `Order: ${p} qty ${q}. Rate same as last time.`,
  (q, p, w, l) => `${p} ${w}x${l} - ${q} pcs urgent`,
];
const NOT_ORDERS = ['Thanks for the payment', 'Monthly newsletter: new offers', 'Happy Diwali!', 'Please send the GST invoice copy', 'Meeting at 4 pm?'];

// Draft orders in every state: waiting for review, read, failed, converted,
// discarded, and plain non-order mail.
async function bulkDrafts(customers) {
  await Intake.deleteMany({});
  const orders = await mongoose.connection.collection('salesorders').find({ status: 'draft' }).project({ number: 1 }).limit(200).toArray();
  const states = [
    ['needs_review', 30],
    ['customer_confirmed', 8],
    ['received', 4],
    ['reading_failed', 4],
    ['converted', 20],
    ['discarded', 8],
    ['stored', 26],
  ];
  const year = new Date().getFullYear();
  const docs = [];
  for (let i = 0; i < COUNTS.drafts; i += 1) {
    let roll = int(1, 100);
    const status = states.find(([, weight]) => (roll -= weight) <= 0)?.[0] || 'needs_review';
    const channel = pick(['whatsapp', 'whatsapp', 'gmail', 'gmail', 'panel']);
    const customer = customers[int(0, customers.length - 1)];
    const known = rand() > 0.3;
    const qty = pick([500, 1000, 2500, 5000, 10000, 17000]);
    const product = pick(PRODUCTS);
    const w = int(6, 24);
    const l = int(8, 36);
    const isOrder = status !== 'stored';
    const body = isOrder ? pick(MESSAGES)(qty, product, w, l) : pick(NOT_ORDERS);
    const at = new Date(Date.now() - (status === 'stored' || status === 'converted' || status === 'discarded' ? int(1, 90) : int(0, 3)) * DAY - int(0, 600) * 60000);
    const providerMessageId = `${channel}-bulk-${i}`;
    const sender = channel === 'gmail'
      ? { email: known ? customer.email : `new${i}@example.test`, name: known ? customer.contactPerson : `New buyer ${i}`, phone: '' }
      : { phone: known ? `91${customer.mobile}` : `91${pad(8000000000 + i, 10)}`, name: known ? customer.contactPerson : `New buyer ${i}`, email: '' };
    const proposal = isOrder && !['received', 'reading_failed'].includes(status)
      ? {
          customer: { name: sender.name, companyName: known ? customer.companyName : '', mobile: sender.phone ? sender.phone.slice(-10) : '', email: sender.email, gstNumber: known && rand() > 0.5 ? customer.gstNumber : '', billingAddress: '', shippingAddress: '' },
          lines: [{ product, quantity: qty, unit: 'pcs', rate: null, material: pick(['LDPE', 'HDPE', 'LLDPE']), width: String(w), length: String(l), notes: '' }],
          deliveryDate: '',
          notes: '',
          certainty: { customer: known ? 'high' : 'medium', lines: 'high' },
          isOrder: true,
          warnings: [],
        }
      : null;
    const open = ['needs_review', 'customer_confirmed', 'received', 'reading_failed', 'stored'].includes(status);
    const converted = status === 'converted' && orders.length ? orders[i % orders.length] : null;
    docs.push({
      number: `IN-${year}-${pad(i + 1)}`,
      channel,
      conversationKey: channel === 'panel' ? '' : `bulk-${i}`,
      ...(open && channel !== 'panel' ? { openKey: `${channel}:bulk-${i}` } : {}),
      messageIds: [providerMessageId],
      messages: [{ _id: id(), providerMessageId, from: sender.email || sender.phone, fromName: sender.name, subject: channel === 'gmail' ? (isOrder ? `PO for ${product}` : body) : '', body, receivedAt: at, fileIds: [] }],
      sender,
      subject: channel === 'gmail' ? (isOrder ? `PO for ${product}` : body) : '',
      rawBody: body,
      potentialOrder: isOrder,
      matchedKeywords: isOrder ? ['pcs', 'order'] : [],
      proposal,
      readings: proposal ? [{ _id: id(), at, provider: 'gemini', model: 'gemini-3.5-flash-lite', proposal, applied: true }] : [],
      status: converted || status !== 'converted' ? status : 'needs_review',
      error: status === 'reading_failed' ? 'Gemini returned 503' : '',
      customer: status === 'customer_confirmed' || converted ? customer._id : null,
      customerName: status === 'customer_confirmed' || converted ? customer.companyName : '',
      salesOrder: converted?._id || null,
      salesOrderNumber: converted?.number || '',
      discardReason: status === 'discarded' ? pick(['Duplicate of a phone order', 'Customer cancelled', 'Only a price enquiry']) : '',
      reviewDueAt: ['needs_review', 'customer_confirmed'].includes(status) ? new Date(at.getTime() + 4 * 60 * 60 * 1000) : null,
      history: [{ at, byName: 'System', action: 'received', note: `From ${channel}` }],
      receivedAt: at,
      lastMessageAt: at,
      createdAt: at,
      updatedAt: at,
    });
  }
  await Intake.insertMany(docs);
  await mongoose.connection.collection('counters').updateOne({ key: `intake:${year}` }, { $set: { seq: docs.length } }, { upsert: true });
  const toReview = await Intake.find({ status: { $in: ['needs_review', 'customer_confirmed'] } });
  for (const doc of toReview) await reviewTasks.ensureReviewTask(doc, 4);
  return docs.length;
}

async function syncOpenOrderTasks() {
  const SalesOrder = require('../modules/salesOrder/salesOrder.model');
  const open = await SalesOrder.find({ status: { $nin: ['completed', 'cancelled'] } }).populate('createdBy', 'fullName');
  for (const order of open) await syncOrder(order, null);
  return open.length;
}

async function main() {
  assertDestructiveSeedAllowed();
  await connectDb();
  const db = mongoose.connection.db;
  console.log(`Loading bulk data into ${db.databaseName}…`);
  await resetDemoCollections();
  const quiet = console.log;
  console.log = () => {};
  try {
    await seed();
  } finally {
    console.log = quiet;
  }
  const customers = await bulkCustomers(db);
  console.log(`customers: ${customers.length}`);
  console.log(`orders added: ${await bulkOrders(db, customers)}`);
  console.log(`stock lots added: ${await bulkLots(db)}`);
  console.log(`draft orders: ${await bulkDrafts(customers)}`);
  console.log(`tasks synced for ${await syncOpenOrderTasks()} open orders`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error('Bulk seed failed', error);
  process.exit(1);
});
