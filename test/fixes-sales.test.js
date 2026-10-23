const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

// Regression tests for the sales setup and draft order fixes.
let db;
let owner;
let customerId;

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')}`;

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  const customer = await db.collection('customers').findOne({ isActive: { $ne: false } });
  customerId = String(customer._id);
});

after(async () => {
  require('../src/utils/jobQueue').stop();
  await h.stopApp();
});

async function panelDraft(proposal = {}) {
  const res = await owner.post('/api/intake/panel', {
    proposal: {
      customer: { name: 'Fix Test Buyer', companyName: '', mobile: '', email: '', gstNumber: '', billingAddress: '', shippingAddress: '' },
      lines: [{ product: 'Polly bag', quantity: 1000, unit: 'pcs', rate: null, material: 'LDPE', width: '10', length: '14', notes: '' }],
      deliveryDate: '',
      notes: '',
      ...proposal,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return res.data.data;
}

async function confirmed(proposal) {
  const draft = await panelDraft(proposal);
  const res = await owner.post(`/api/intake/${draft.id}/customer`, { customerId, version: draft.version });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.data;
}

async function orderOf(res) {
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return db.collection('salesorders').findOne({ _id: h.asId(res.data.data.order.id) });
}

test('converted lines get GST: 18% for saved products (tax lives on the line), the real rate for customer products', async () => {
  const template = await owner.post('/api/sales-settings/templates', {
    name: 'Fix Tax Bag',
    product: 'Fix Tax Bag',
    productionRoute: 'roll_cut_dispatch',
    unit: 'pcs',
    material: 'LDPE',
    width: '10',
    length: '12',
    taxPercent: 5,
  });
  assert.equal(template.status, 201, JSON.stringify(template.data));
  const templateId = template.data.data.id;

  const productId = h.asId('6553f0000000000000000001');
  await db.collection('customers').updateOne(
    { _id: h.asId(customerId) },
    { $push: { products: { _id: productId, product: 'Customer Pouch', unit: 'pcs', productionRoute: 'roll_cut_dispatch', taxPercent: 12, images: [] } } }
  );

  const draft = await confirmed();
  const order = await orderOf(
    await owner.post(`/api/intake/${draft.id}/convert`, {
      version: draft.version,
      lines: [
        { product: 'Fix Tax Bag', quantity: 500, source: 'template', sourceId: templateId, productionRoute: 'roll_cut_dispatch' },
        { product: 'Customer Pouch', quantity: 700, source: 'customer', sourceId: String(productId), productionRoute: 'roll_cut_dispatch' },
        { product: 'Typed line', quantity: 900, productionRoute: 'roll_cut_dispatch' },
      ],
    })
  );
  assert.deepEqual(
    order.items.map((item) => item.taxPercent),
    [18, 12, 18]
  );
});

test('customer PO date from the message: past dates kept, future dates refused', async () => {
  const past = await confirmed({ poNumber: 'PO-1', poDate: '2026-01-15' });
  const pastOrder = await orderOf(
    await owner.post(`/api/intake/${past.id}/convert`, { version: past.version, lines: [{ product: 'Bag', quantity: 10, productionRoute: 'roll_cut_dispatch' }] })
  );
  assert.ok(pastOrder.customerPoDate, 'past PO date kept');
  assert.equal(pastOrder.customerPoNumber, 'PO-1');

  const future = await confirmed({ poNumber: 'PO-2', poDate: '2099-01-15' });
  const futureOrder = await orderOf(
    await owner.post(`/api/intake/${future.id}/convert`, { version: future.version, lines: [{ product: 'Bag', quantity: 10, productionRoute: 'roll_cut_dispatch' }] })
  );
  assert.equal(futureOrder.customerPoDate || null, null, 'future PO date dropped');

  const bad = await confirmed({ poDate: '2026-02-31' });
  const badOrder = await orderOf(
    await owner.post(`/api/intake/${bad.id}/convert`, { version: bad.version, lines: [{ product: 'Bag', quantity: 10, productionRoute: 'roll_cut_dispatch' }] })
  );
  assert.equal(badOrder.customerPoDate || null, null, 'impossible date dropped');
});

test('convert marks the draft converted before copying files, so a second convert is refused while files copy', async () => {
  const { uploadBuffer } = require('../src/utils/storage');
  const stored = await uploadBuffer({ buffer: Buffer.from('po file'), originalName: 'po.txt', mimeType: 'text/plain', folder: 'intake-test' });
  const draft = await confirmed();
  await db.collection('intakes').updateOne(
    { _id: h.asId(draft.id) },
    { $push: { files: { _id: h.asId('6553f0000000000000000002'), originalName: 'po.txt', mimeType: 'text/plain', key: stored.key, storage: stored.storage, size: 7 } } }
  );
  const fresh = (await owner.get(`/api/intake/${draft.id}`)).data.data;
  const payload = { version: fresh.version, lines: [{ product: 'Bag', quantity: 10, productionRoute: 'roll_cut_dispatch' }] };

  const salesOrderService = require('../src/modules/salesOrder/salesOrder.service');
  const original = salesOrderService.addAttachment;
  let seen = null;
  salesOrderService.addAttachment = async () => {
    const during = await db.collection('intakes').findOne({ _id: h.asId(draft.id) });
    // Even with the convert lock expired, a second click must not make a second order.
    await db.collection('intakes').updateOne({ _id: during._id }, { $set: { convertingAt: new Date(Date.now() - 10 * 60 * 1000) } });
    const again = await owner.post(`/api/intake/${draft.id}/convert`, { ...payload, version: undefined });
    seen = { status: during.status, salesOrder: during.salesOrder, again: again.status };
    throw new Error('disk full');
  };
  let res;
  try {
    res = await owner.post(`/api/intake/${draft.id}/convert`, payload);
  } finally {
    salesOrderService.addAttachment = original;
  }
  const order = await orderOf(res);
  assert.equal(seen.status, 'converted');
  assert.equal(String(seen.salesOrder), String(order._id));
  assert.notEqual(seen.again, 201);
  assert.equal(await db.collection('salesorders').countDocuments({ sourceIntake: h.asId(draft.id) }), 1);
  assert.match(res.data.data.warnings[0], /disk full/);
  const after = await db.collection('intakes').findOne({ _id: h.asId(draft.id) });
  assert.equal(after.status, 'converted');
  assert.ok(after.history.some((entry) => entry.action === 'files_not_copied'));
});

test('creating a customer from a draft reuses one with the same GST number or mobile instead of duplicating', async () => {
  const gst = '27ABCDE1234F1Z5';
  const first = await panelDraft();
  const made = await owner.post(`/api/intake/${first.id}/customer`, { create: { name: 'Gst Twin Traders', gstNumber: gst }, version: first.version });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(made.data.data.status, 'customer_confirmed');
  const createdId = String((await db.collection('intakes').findOne({ _id: h.asId(first.id) })).customer);

  // A retry (or a second draft from the same buyer) links the same customer.
  const second = await panelDraft();
  const again = await owner.post(`/api/intake/${second.id}/customer`, { create: { name: 'Gst Twin Traders', gstNumber: gst.toLowerCase() }, version: second.version });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(await db.collection('customers').countDocuments({ gstNumber: new RegExp(gst, 'i') }), 1);
  const linked = await db.collection('intakes').findOne({ _id: h.asId(second.id) });
  assert.equal(String(linked.customer), createdId);
  assert.equal(linked.customerName, 'Gst Twin Traders');
  assert.equal(linked.history.at(-1).action, 'customer_confirmed');

  const third = await panelDraft();
  await owner.post(`/api/intake/${third.id}/customer`, { create: { name: 'Mobile Twin', mobile: '+91 98111 22334' }, version: third.version });
  const fourth = await panelDraft();
  const viaMobile = await owner.post(`/api/intake/${fourth.id}/customer`, { create: { name: 'Mobile Twin again', mobile: '9811122334' }, version: fourth.version });
  assert.equal(viaMobile.status, 200, JSON.stringify(viaMobile.data));
  assert.equal(await db.collection('customers').countDocuments({ name: /^Mobile Twin/ }), 1);

  // A closed draft is not linked.
  const closed = await panelDraft();
  await db.collection('intakes').updateOne({ _id: h.asId(closed.id) }, { $set: { status: 'discarded' } });
  const refused = await owner.post(`/api/intake/${closed.id}/customer`, { customerId, version: closed.version });
  assert.ok(refused.status >= 400);
});

test('saved products: on/off works without mandatory fields; inline photos are stored as files', async () => {
  const inserted = await db.collection('producttemplates').insertOne({ name: 'Old Incomplete Product', isActive: true, images: [] });
  const off = await owner.patch(`/api/sales-settings/templates/${inserted.insertedId}`, { isActive: false });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal((await db.collection('producttemplates').findOne({ _id: inserted.insertedId })).isActive, false);
  const edit = await owner.patch(`/api/sales-settings/templates/${inserted.insertedId}`, { isActive: true, code: 'X1' });
  assert.equal(edit.status, 400, 'a real edit still checks mandatory fields');

  const created = await owner.post('/api/sales-settings/templates', {
    name: 'Photo Product',
    productionRoute: 'roll_cut_dispatch',
    unit: 'pcs',
    images: [{ dataUrl: PNG_DATA_URL, originalName: 'photo.png' }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const saved = await db.collection('producttemplates').findOne({ _id: h.asId(created.data.data.id) });
  assert.ok(saved.images.length >= 1);
  for (const image of saved.images) {
    assert.ok(!image.dataUrl, 'no base64 in the record');
    assert.ok(image.url, 'stored file url');
  }
});

test('job queue: a rerun asked for while running is kept; long jobs renew their lock', async () => {
  const jobs = require('../src/utils/jobQueue');
  jobs.setHeartbeatMs(40);
  let runs = 0;
  const locks = [];
  jobs.register('fix-test-rerun', async (payload, job) => {
    runs += 1;
    if (runs === 1) {
      await jobs.enqueue('fix-test-rerun', { n: 2 }, { key: 'fix-test' });
      locks.push((await jobs.Job.findById(job._id).lean()).lockedUntil);
      await new Promise((resolve) => setTimeout(resolve, 200));
      locks.push((await jobs.Job.findById(job._id).lean()).lockedUntil);
    }
  });
  try {
    await jobs.enqueue('fix-test-rerun', { n: 1 }, { key: 'fix-test' });
    await jobs.tick({ wait: true });
    const mid = await jobs.Job.findOne({ type: 'fix-test-rerun' }).lean();
    assert.equal(mid.status, 'pending', 'rerun kept');
    assert.equal(mid.rerun, false);
    assert.ok(locks[1] > locks[0], 'lock renewed while running');
    await jobs.drain();
    assert.equal(runs, 2);
    const done = await jobs.Job.findOne({ type: 'fix-test-rerun' }).lean();
    assert.equal(done.status, 'done');
    assert.equal(done.activeKey, undefined);
  } finally {
    jobs.setHeartbeatMs(60 * 1000);
  }
});
