const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const h = require('./helpers');

// Converting a draft: the product picker, new products saved to the customer,
// extra lines, and marking the source mail / WhatsApp chat afterwards. Gmail
// and the WhatsApp Graph API are fakes; nothing leaves this machine.
const graph = [];
let graphFails = false;
let fake;
let db;
let owner;
let jobs;
let service;
let delta;

function startFake() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/graph/PHONE-ID/messages') {
          const json = body ? JSON.parse(body) : {};
          if (graphFails) {
            res.writeHead(500);
            return res.end(JSON.stringify({ error: { message: 'graph is down' } }));
          }
          graph.push(json);
          res.writeHead(200);
          return res.end(JSON.stringify({ success: true }));
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: { message: 'not found' } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let seq = 0;
async function makeDraft(channel, { messages = 1, receivedAt = new Date(), from } = {}) {
  seq += 1;
  let doc;
  const sender = channel === 'gmail' ? { email: 'buyer@delta.example', name: 'Buyer' } : { phone: from || `9190000${String(seq).padStart(5, '0')}`, name: 'Buyer' };
  for (let i = 0; i < messages; i += 1) {
    ({ doc } = await service.ingestMessage({
      channel,
      conversationKey: channel === 'gmail' ? `thread-${seq}` : sender.phone,
      message: { providerMessageId: `${channel}-${seq}-${i}`, from: sender.email || sender.phone, fromName: 'Buyer', body: 'order 500 pcs printed courier bag', receivedAt },
      sender,
      potentialOrder: true,
    }));
  }
  await db.collection('intakes').updateOne(
    { _id: doc._id },
    { $set: { status: 'needs_review', proposal: { customer: {}, lines: [{ product: 'Printed courier bag', quantity: 500, unit: 'pcs', material: 'LDPE', width: '', length: '' }] } } }
  );
  const view = (await owner.get(`/api/intake/${doc._id}`)).data.data;
  const confirmed = await owner.post(`/api/intake/${doc._id}/customer`, { customerId: String(delta._id), version: view.version });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  return confirmed.data.data;
}

const simpleLine = { product: 'Printed courier bag', quantity: 500, unit: 'pcs', productionRoute: 'roll_print_dispatch' };

function history(draftId) {
  return db.collection('intakes').findOne({ _id: h.asId(draftId) }).then((doc) => doc.history);
}

before(async () => {
  fake = await startFake();
  process.env.WHATSAPP_GRAPH_BASE = `http://127.0.0.1:${fake.address().port}/graph`;
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  jobs = require('../src/utils/jobQueue');
  service = require('../src/modules/intake/intake.service');
  require('../src/modules/intake/intake.jobs').registerIntakeJobs();
  const saved = await owner.put('/api/intake/settings', { whatsappAccessToken: 'wa-token', whatsappPhoneNumberId: 'PHONE-ID', autoReplyTestMode: false });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  delta = await db.collection('customers').findOne({ name: 'Delta Plastics' });
  const now = new Date();
  await db.collection('producttemplates').insertMany([
    { name: 'Garbage bag 24x30', product: 'Garbage bag', code: 'GB-2430', material: 'HDPE', size: '24x30', unit: 'pcs', productionRoute: 'roll_cut_dispatch', isActive: true, createdAt: now, updatedAt: now },
    { name: 'Courier bag plain', product: 'Courier bag', code: 'CB-01', material: 'LDPE', unit: 'pcs', productionRoute: 'roll_cut_dispatch', isActive: true, createdAt: now, updatedAt: now },
    { name: 'Old shrink film', product: 'Shrink film', code: 'SF-01', unit: 'kg', productionRoute: 'roll_dispatch', isActive: false, createdAt: now, updatedAt: now },
  ]);
});

after(async () => {
  jobs?.stop();
  require('../src/modules/intake/intake.gmail').setClientFactory(null);
  await new Promise((r) => fake.close(r));
  await h.stopApp();
});

test('product picker lists the customer\'s products and active saved products, best match first, with search', async () => {
  const draft = await makeDraft('panel');
  const all = (await owner.get(`/api/intake/${draft.id}/products?line=0`)).data.data;
  assert.equal(all.customer.total, delta.products.length);
  assert.equal(all.customer.items[0].product, 'Printed courier bag', 'best match first');
  assert.equal(all.customer.items[0].strong, true);
  const active = await db.collection('producttemplates').countDocuments({ isActive: { $ne: false } });
  assert.equal(all.saved.total, active, 'inactive saved products are left out');
  assert.ok(!all.saved.items.some((p) => p.productCode === 'SF-01'));
  assert.ok(all.saved.items.findIndex((p) => p.productCode === 'CB-01') < all.saved.items.findIndex((p) => p.productCode === 'GB-2430'), 'closer saved product first');

  const searched = (await owner.get(`/api/intake/${draft.id}/products?q=garbage`)).data.data;
  assert.equal(searched.customer.total, 0);
  assert.deepEqual(searched.saved.items.map((p) => p.productCode), ['GB-2430']);
  const own = (await owner.get(`/api/intake/${draft.id}/products?q=cutting bag`)).data.data;
  assert.deepEqual(own.customer.items.map((p) => p.product), ['Plain cutting bag']);

  const found = (await owner.get('/api/intake/customers?q=delta')).data.data;
  assert.ok(found.some((c) => c.id === String(delta._id)));
});

test('convert: customer product, saved product, new products (saved / not saved) and an extra line', async () => {
  const draft = await makeDraft('panel');
  const before = (await db.collection('customers').findOne({ _id: delta._id })).products;
  const printed = before.find((p) => p.product === 'Printed courier bag');
  const cutting = before.find((p) => p.product === 'Plain cutting bag');
  const template = await db.collection('producttemplates').findOne({ code: 'GB-2430' });
  const res = await owner.post(`/api/intake/${draft.id}/convert`, {
    version: draft.version,
    lines: [
      { ...simpleLine, source: 'customer', sourceId: String(printed._id) },
      { product: 'Garbage bag', quantity: 200, unit: 'pcs', source: 'template', sourceId: String(template._id), productionRoute: 'roll_cut_dispatch', saveToCustomer: true },
      { product: 'Zip lock pouch', quantity: 300, unit: 'pcs', rate: 2.5, productionRoute: 'roll_cut_dispatch', saveToCustomer: true },
      { product: 'Sample sleeve', quantity: 50, unit: 'pcs', productionRoute: 'roll_cut_dispatch', saveToCustomer: false },
      { product: cutting.product, quantity: 1000, unit: 'pcs', rate: 1.2, source: 'customer', sourceId: String(cutting._id), extra: true, productionRoute: cutting.productionRoute },
    ],
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.deepEqual(res.data.data.warnings, []);
  const order = await db.collection('salesorders').findOne({ _id: h.asId(res.data.data.order.id) });
  assert.deepEqual(
    order.items.map((item) => item.product),
    ['Printed courier bag', 'Garbage bag', 'Zip lock pouch', 'Sample sleeve', 'Plain cutting bag']
  );
  assert.equal(order.items[4].quantity, 1000);
  assert.equal(order.items[4].rate, 1.2);
  const after = (await db.collection('customers').findOne({ _id: delta._id })).products;
  assert.equal(after.length, before.length + 1, 'only the ticked new product is added');
  const zip = after.find((p) => p.product === 'Zip lock pouch');
  assert.equal(zip.productionRoute, 'roll_cut_dispatch');
  assert.equal(zip.rate, 2.5);
  assert.ok(!after.some((p) => p.product === 'Sample sleeve'));
  assert.ok((await history(draft.id)).some((e) => e.action === 'products_saved' && /Zip lock pouch/.test(e.note)));
  assert.ok(!(await history(draft.id)).some((e) => /^(gmail|whatsapp)_marked|mark_failed$/.test(e.action)), 'panel drafts are not marked');
});

test('a new product already on the customer list (same name) is not added twice', async () => {
  const draft = await makeDraft('panel');
  const before = (await db.collection('customers').findOne({ _id: delta._id })).products.length;
  const res = await owner.post(`/api/intake/${draft.id}/convert`, {
    version: draft.version,
    lines: [{ ...simpleLine, product: 'Printed courier bag', saveToCustomer: true }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal((await db.collection('customers').findOne({ _id: delta._id })).products.length, before, 'already on the list');
});

test('Gmail: every mail gets the Converted label and loses UNREAD; the label is made once', async () => {
  const gmail = require('../src/modules/intake/intake.gmail');
  const settingsModule = require('../src/modules/intake/intake.settings');
  await settingsModule.updateSettingsFields({ gmailClientId: 'id', gmailClientSecret: 'secret', gmailRefreshToken: 'refresh', gmailEmail: 'sales@ourplant.example' });
  const calls = { create: 0, modify: [] };
  gmail.setClientFactory(() => ({
    users: {
      labels: {
        list: async () => ({ data: { labels: [] } }),
        create: async ({ requestBody }) => {
          calls.create += 1;
          assert.equal(requestBody.name, 'Sinopec/Converted');
          return { data: { id: 'Label_9' } };
        },
      },
      messages: { batchModify: async ({ requestBody }) => calls.modify.push(requestBody) },
    },
  }));
  for (const messages of [2, 1]) {
    const draft = await makeDraft('gmail', { messages });
    const res = await owner.post(`/api/intake/${draft.id}/convert`, { version: draft.version, lines: [simpleLine] });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    await jobs.drain();
    const entry = (await history(draft.id)).find((e) => e.action === 'gmail_marked');
    assert.ok(entry, 'recorded in history');
  }
  assert.equal(calls.create, 1, 'label created once');
  assert.equal(calls.modify.length, 2);
  assert.equal(calls.modify[0].ids.length, 2, 'every mail in the draft');
  assert.deepEqual(calls.modify[0].addLabelIds, ['Label_9']);
  assert.deepEqual(calls.modify[0].removeLabelIds, ['UNREAD']);
  assert.equal((await db.collection('intakesettings').findOne({ key: 'default' })).gmailConvertedLabelId, 'Label_9');
});

test('Gmail marking failure keeps the order and is recorded in the history', async () => {
  const gmail = require('../src/modules/intake/intake.gmail');
  gmail.setClientFactory(() => ({
    users: { messages: { batchModify: async () => Promise.reject(Object.assign(new Error('Gmail is having a bad day'), { code: 503 })) } },
  }));
  const draft = await makeDraft('gmail');
  const res = await owner.post(`/api/intake/${draft.id}/convert`, { version: draft.version, lines: [simpleLine] });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  await jobs.drain();
  const doc = await db.collection('intakes').findOne({ _id: h.asId(draft.id) });
  assert.equal(doc.status, 'converted');
  assert.ok(await db.collection('salesorders').findOne({ _id: doc.salesOrder }));
  const failed = doc.history.find((e) => e.action === 'mark_failed');
  assert.match(failed.note, /bad day/);
  gmail.setClientFactory(null);
});

test('WhatsApp: marks the last message read and confirms the order inside the 24-hour window', async () => {
  graph.length = 0;
  const draft = await makeDraft('whatsapp', { messages: 2 });
  const res = await owner.post(`/api/intake/${draft.id}/convert`, { version: draft.version, lines: [simpleLine] });
  assert.equal(res.status, 201);
  await jobs.drain();
  const doc = await db.collection('intakes').findOne({ _id: h.asId(draft.id) });
  const read = graph.find((m) => m.status === 'read');
  assert.equal(read.message_id, doc.messages[1].providerMessageId, 'the latest message');
  const sent = graph.find((m) => m.type === 'text');
  assert.equal(sent.to, doc.sender.phone);
  assert.equal(sent.text.body, `Thank you. Your order is booked as ${doc.salesOrderNumber}.`);
  assert.equal(doc.replies.at(-1).kind, 'booked');
  assert.equal(doc.replies.at(-1).status, 'sent');
  assert.ok(doc.history.some((e) => e.action === 'whatsapp_marked' && /confirmation sent/.test(e.note)));
});

test('WhatsApp: no confirmation in test mode, outside the 24-hour window, or when switched off', async () => {
  graph.length = 0;
  await owner.put('/api/intake/settings', { autoReplyTestMode: true, autoReplyTestRecipients: '' });
  const testMode = await makeDraft('whatsapp');
  await owner.post(`/api/intake/${testMode.id}/convert`, { version: testMode.version, lines: [simpleLine] });
  await jobs.drain();
  assert.equal(graph.filter((m) => m.type === 'text').length, 0);
  assert.equal(graph.filter((m) => m.status === 'read').length, 1, 'still marked read');
  assert.match((await db.collection('intakes').findOne({ _id: h.asId(testMode.id) })).replies.at(-1).reason, /test mode/i);

  await owner.put('/api/intake/settings', { autoReplyTestMode: false });
  const old = await makeDraft('whatsapp', { receivedAt: new Date(Date.now() - 30 * 60 * 60 * 1000) });
  await owner.post(`/api/intake/${old.id}/convert`, { version: old.version, lines: [simpleLine] });
  await jobs.drain();
  assert.equal(graph.filter((m) => m.type === 'text').length, 0);
  const oldDoc = await db.collection('intakes').findOne({ _id: h.asId(old.id) });
  assert.equal(oldDoc.replies.at(-1).status, 'skipped');
  assert.match(oldDoc.replies.at(-1).reason, /24 hours/);

  await owner.put('/api/intake/settings', { confirmConvertedWhatsapp: false });
  assert.equal((await owner.get('/api/intake/settings')).data.data.confirmConvertedWhatsapp, false);
  const off = await makeDraft('whatsapp');
  await owner.post(`/api/intake/${off.id}/convert`, { version: off.version, lines: [simpleLine] });
  await jobs.drain();
  assert.equal(graph.filter((m) => m.type === 'text').length, 0);
  assert.match((await db.collection('intakes').findOne({ _id: h.asId(off.id) })).replies.at(-1).reason, /switched off/);
  await owner.put('/api/intake/settings', { confirmConvertedWhatsapp: true });
});

test('WhatsApp failure does not fail the convert and is recorded', async () => {
  graphFails = true;
  try {
    const draft = await makeDraft('whatsapp');
    const res = await owner.post(`/api/intake/${draft.id}/convert`, { version: draft.version, lines: [simpleLine] });
    assert.equal(res.status, 201);
    await jobs.drain();
    const doc = await db.collection('intakes').findOne({ _id: h.asId(draft.id) });
    assert.equal(doc.status, 'converted');
    const failed = doc.history.find((e) => e.action === 'mark_failed');
    assert.match(failed.note, /graph is down/);
    assert.equal(doc.replies.at(-1).status, 'failed');
  } finally {
    graphFails = false;
  }
});
