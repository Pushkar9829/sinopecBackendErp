const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const h = require('./helpers');

// Fake outside services: an AI reader (Gemini / Claude / OpenAI-compatible
// shapes) and the WhatsApp Graph API. Nothing leaves this machine.
const calls = { gemini: [], claude: [], openai: [], graphSent: [] };
let aiAnswer = null;
let fake;
let db;
let owner;
let jobs;
const APP_SECRET = 'test-app-secret';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function proposalFor(text) {
  if (aiAnswer) return aiAnswer(text);
  // Only the customer's part, not the instructions.
  const message = text.slice(text.indexOf('Sender from the channel') >= 0 ? text.indexOf('Sender from the channel') : text.indexOf('Message:'));
  const all = [...message.matchAll(/(\d{3,6})\s*(pcs|bags?)/gi)];
  const qty = Number(all.at(-1)?.[1]) || null;
  return {
    customer: { name: 'Raj Kumar', companyName: '', mobile: '', email: '', gstNumber: '', billingAddress: '', shippingAddress: '' },
    lines: qty ? [{ product: 'Polly bag', quantity: qty, unit: 'pcs', rate: null, material: 'LDPE', width: '10', length: '14', notes: '' }] : [],
    deliveryDate: '',
    notes: '',
    certainty: { customer: 'medium', lines: qty ? 'high' : 'missing' },
    isOrder: !/newsletter/i.test(message),
    warnings: [],
  };
}

function startFake() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const json = body ? JSON.parse(body) : {};
        const send = (status, data, type = 'application/json') => {
          res.writeHead(status, { 'Content-Type': type });
          res.end(type === 'application/json' ? JSON.stringify(data) : data);
        };
        if (req.url.includes(':generateContent')) {
          calls.gemini.push({ headers: req.headers, url: req.url, json });
          const text = json.contents[0].parts.map((p) => p.text || '').join('\n');
          return send(200, {
            candidates: [{ content: { parts: [{ text: JSON.stringify(proposalFor(text)) }] } }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
          });
        }
        if (req.url.startsWith('/v1/messages')) {
          calls.claude.push({ headers: req.headers, json });
          const text = json.messages[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          return send(200, {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: json.model,
            content: [{ type: 'text', text: JSON.stringify(proposalFor(text)) }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 120, output_tokens: 60 },
          });
        }
        if (req.url === '/openai/chat/completions') {
          calls.openai.push({ json });
          return send(500, { error: { message: 'model server down' } });
        }
        if (req.url === '/graph/media-1') return send(200, { url: `http://127.0.0.1:${server.address().port}/graph/file-1`, mime_type: 'image/png', file_size: PNG.length });
        if (req.url === '/graph/file-1') return send(200, PNG, 'image/png');
        if (req.url === '/graph/PHONE-ID/messages') {
          calls.graphSent.push(json);
          return send(200, { messages: [{ id: 'wamid.out' }] });
        }
        return send(404, { error: { message: 'not found' } });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function webhook(payload, secret = APP_SECRET) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  return fetch(`${h.baseUrl}/api/intake/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body: raw,
  });
}

let wamid = 0;
function waMessage(from, text, extra = {}) {
  wamid += 1;
  return {
    entry: [{ changes: [{ value: { contacts: [{ profile: { name: 'Raj' } }], messages: [{ id: `wamid.${wamid}`, from, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text }, ...extra }] } }] }],
  };
}

const intakes = () => db.collection('intakes');

before(async () => {
  fake = await startFake();
  const base = `http://127.0.0.1:${fake.address().port}`;
  process.env.GEMINI_API_BASE = base;
  process.env.ANTHROPIC_API_BASE = base;
  process.env.WHATSAPP_GRAPH_BASE = `${base}/graph`;
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  jobs = require('../src/utils/jobQueue');
  require('../src/modules/intake/intake.jobs').registerIntakeJobs();
  const saved = await owner.put('/api/intake/settings', {
    whatsappAppSecret: APP_SECRET,
    whatsappAccessToken: 'wa-token',
    whatsappPhoneNumberId: 'PHONE-ID',
    geminiApiKey: 'gemini-test-key',
    aiProvider: 'gemini',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
});

after(async () => {
  jobs?.stop();
  await new Promise((r) => fake.close(r));
  await h.stopApp();
});

test('only users with draft order access can see drafts; sales users no longer can', async () => {
  assert.equal((await owner.get('/api/intake')).status, 200);
  const sales = await h.signIn('sales');
  assert.equal((await sales.get('/api/intake')).status, 403);
  assert.equal((await sales.get('/api/intake/settings')).status, 403);
});

test('secrets are encrypted at rest, never returned, and hidden from the audit log', async () => {
  const stored = await db.collection('intakesettings').findOne({ key: 'default' });
  assert.match(stored.geminiApiKey, /^enc:v1:/);
  assert.match(stored.whatsappAccessToken, /^enc:v1:/);
  const view = (await owner.get('/api/intake/settings')).data.data;
  assert.equal(view.geminiApiKeySet, true);
  assert.equal(view.geminiApiKey, undefined);
  assert.equal(JSON.stringify(view).includes('gemini-test-key'), false);
  await new Promise((r) => setTimeout(r, 300));
  const logs = await db.collection('auditlogs').find({}).toArray();
  assert.equal(JSON.stringify(logs).includes('gemini-test-key'), false);
});

test('legacy plain-text secrets are read and encrypted on first use', async () => {
  await db.collection('intakesettings').updateOne({ key: 'default' }, { $set: { claudeApiKey: 'plain-legacy-key' } });
  const settings = await require('../src/modules/intake/intake.settings').getSettings();
  assert.equal(settings.claudeApiKey, 'plain-legacy-key');
  assert.match((await db.collection('intakesettings').findOne({ key: 'default' })).claudeApiKey, /^enc:v1:/);
});

test('WhatsApp: bad signature refused; messages queued, grouped into one draft, read, and a review task opened', async () => {
  assert.equal((await webhook(waMessage('919876543210', 'order 5000 pcs'), 'wrong')).status, 401);
  const first = waMessage('919876543210', 'Hello, need order of polly bags');
  assert.equal((await webhook(first)).status, 200);
  assert.equal((await webhook(first)).status, 200, 'Meta retries the same message');
  await webhook(waMessage('919876543210', '5000 pcs 10x14 please'));
  await jobs.drain();
  const docs = await intakes().find({ channel: 'whatsapp' }).toArray();
  assert.equal(docs.length, 1, 'one conversation');
  const draft = docs[0];
  assert.equal(draft.messages.length, 2);
  assert.equal(draft.status, 'needs_review');
  assert.equal(draft.proposal.lines[0].quantity, 5000);
  assert.equal(draft.customerMatch.best, String((await db.collection('customers').findOne({ mobile: '9876543210' }))._id), 'matched by mobile');
  assert.equal(calls.gemini.at(-1).headers['x-goog-api-key'], 'gemini-test-key');
  assert.ok(!calls.gemini.at(-1).url.includes('key='), 'key not in the URL');
  const task = await db.collection('tasks').findOne({ intake: draft._id, category: 'intake_review' });
  assert.ok(task && task.status === 'open' && task.assigneeRole === 'super_admin');
});

test('WhatsApp photo: downloaded in the job, private, and served only through the API', async () => {
  await webhook(waMessage('919000000001', '', { type: 'image', text: undefined, image: { id: 'media-1', mime_type: 'image/png' } }));
  await jobs.drain();
  const draft = await intakes().findOne({ conversationKey: '919000000001' });
  assert.equal(draft.files.length, 1);
  assert.equal(draft.potentialOrder, true, 'a captionless photo is a possible order');
  const view = (await owner.get(`/api/intake/${draft._id}`)).data.data;
  assert.equal(view.files[0].url, undefined);
  assert.equal(view.files[0].key, undefined);
  const file = await owner.get(`/api/intake/${draft._id}/files/${view.files[0].id}`);
  assert.equal(file.status, 200);
  assert.deepEqual(Buffer.from(file.data), PNG);
  assert.equal((await fetch(`${h.baseUrl}${draft.files[0].url}`)).status, 404, 'not public');
});

test('a person\'s edits are kept when a new message arrives; the new reading waits to be applied', async () => {
  const draft = await intakes().findOne({ conversationKey: '919876543210' });
  const view = (await owner.get(`/api/intake/${draft._id}`)).data.data;
  const proposal = { ...view.proposal, notes: 'checked by owner' };
  const saved = await owner.put(`/api/intake/${draft._id}`, { proposal, version: view.version });
  assert.equal(saved.status, 200);
  assert.equal((await owner.put(`/api/intake/${draft._id}`, { proposal, version: view.version })).status, 409, 'stale version refused');
  await webhook(waMessage('919876543210', 'make it 7000 pcs'));
  await jobs.drain();
  const after = await intakes().findOne({ _id: draft._id });
  assert.equal(after.proposal.notes, 'checked by owner');
  assert.equal(after.proposal.lines[0].quantity, 5000);
  assert.equal(after.newReadingAvailable, true);
  const latest = after.readings.at(-1);
  assert.equal(latest.proposal.lines[0].quantity, 7000);
  const fresh = (await owner.get(`/api/intake/${draft._id}`)).data.data;
  const used = await owner.post(`/api/intake/${draft._id}/readings/${String(latest._id)}/use`, { version: fresh.version });
  assert.equal(used.status, 200);
  assert.equal(used.data.data.proposal.lines[0].quantity, 7000);
});

test('confirm customer, then convert to a DRAFT sales order: files as PO, no new templates, task done, once only', async () => {
  const draft = await intakes().findOne({ conversationKey: '919876543210' });
  let view = (await owner.get(`/api/intake/${draft._id}`)).data.data;
  assert.equal((await owner.post(`/api/intake/${draft._id}/convert`, { version: view.version, lines: [] })).status, 400, 'customer first');
  const confirmed = await owner.post(`/api/intake/${draft._id}/customer`, { customerId: draft.customerMatch.best, version: view.version });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  assert.equal(confirmed.data.data.status, 'customer_confirmed');
  view = confirmed.data.data;

  const match = (await owner.get(`/api/intake/${draft._id}/match`)).data.data;
  assert.ok(match.routes.length > 0);
  const templatesBefore = await db.collection('producttemplates').countDocuments();
  const line = view.proposal.lines[0];
  const payload = { version: view.version, lines: [{ ...line, productionRoute: 'roll_cut_dispatch' }] };
  const [a, b] = await Promise.all([owner.post(`/api/intake/${draft._id}/convert`, payload), owner.post(`/api/intake/${draft._id}/convert`, payload)]);
  const okOnes = [a, b].filter((r) => r.status === 201);
  assert.equal(okOnes.length, 1, `${a.status}/${b.status}`);
  const result = okOnes[0].data.data;
  const order = await db.collection('salesorders').findOne({ _id: h.asId(result.order.id) });
  assert.equal(order.status, 'draft');
  assert.equal(String(order.sourceIntake), String(draft._id));
  assert.equal(order.items[0].quantity, 7000);
  assert.equal(await db.collection('salesorders').countDocuments({ sourceIntake: draft._id }), 1);
  assert.equal(await db.collection('producttemplates').countDocuments(), templatesBefore, 'no templates made from a draft');
  assert.equal(result.draft.status, 'converted');
  const task = await db.collection('tasks').findOne({ intake: draft._id, category: 'intake_review' });
  assert.equal(task.status, 'done');
  const orderView = (await owner.get(`/api/sales-orders/${order._id}`)).data.data;
  assert.equal(orderView.sourceIntakeNumber, draft.number);
});

test('converted photo draft copies its files onto the order as PO attachments', async () => {
  const draft = await intakes().findOne({ conversationKey: '919000000001' });
  let view = (await owner.get(`/api/intake/${draft._id}`)).data.data;
  const customer = await db.collection('customers').findOne({ name: 'Delta Plastics' });
  view = (await owner.post(`/api/intake/${draft._id}/customer`, { customerId: String(customer._id), version: view.version })).data.data;
  const res = await owner.post(`/api/intake/${draft._id}/convert`, {
    version: view.version,
    lines: [{ product: 'Printed pouch', quantity: 1000, unit: 'pcs', productionRoute: 'roll_print_dispatch' }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const order = await db.collection('salesorders').findOne({ _id: h.asId(res.data.data.order.id) });
  assert.equal(order.attachments.length, 1);
  assert.equal(order.attachments[0].kind, 'po');
});

test('discard needs a reason and can be undone', async () => {
  await webhook(waMessage('919000000002', 'order 300 bags'));
  await jobs.drain();
  const draft = await intakes().findOne({ conversationKey: '919000000002' });
  const view = (await owner.get(`/api/intake/${draft._id}`)).data.data;
  assert.equal((await owner.post(`/api/intake/${draft._id}/discard`, { version: view.version })).status, 400);
  const discarded = await owner.post(`/api/intake/${draft._id}/discard`, { version: view.version, reason: 'duplicate of phone order' });
  assert.equal(discarded.data.data.status, 'discarded');
  assert.equal((await db.collection('tasks').findOne({ intake: draft._id })).status, 'cancelled');
  const restored = await owner.post(`/api/intake/${draft._id}/restore`, {});
  assert.equal(restored.data.data.status, 'needs_review');
  assert.equal(await db.collection('tasks').countDocuments({ intake: draft._id, status: 'open' }), 1);
});

test('automatic replies: off by default, test mode only answers listed numbers, once per conversation', async () => {
  await webhook(waMessage('919000000003', 'order 100 pcs'));
  await jobs.drain();
  assert.equal(calls.graphSent.length, 0, 'switched off by default');

  await owner.put('/api/intake/settings', { autoReplyEnabled: true, autoReplyTestMode: true, autoReplyTestRecipients: '+91 90000 00005' });
  await webhook(waMessage('919000000004', 'order 200 pcs'));
  await jobs.drain();
  assert.equal(calls.graphSent.length, 0, 'not on the test list');
  const skipped = await intakes().findOne({ conversationKey: '919000000004' });
  assert.match(skipped.replies[0].reason, /test mode/i);

  await webhook(waMessage('919000000005', 'order 300 pcs'));
  await jobs.drain();
  assert.equal(calls.graphSent.length, 1);
  assert.equal(calls.graphSent[0].to, '919000000005');
  const answered = await intakes().findOne({ conversationKey: '919000000005' });
  assert.match(calls.graphSent[0].text.body, new RegExp(answered.number));
  await require('../src/modules/intake/intake.replies').sendReply({ intakeId: String(answered._id) });
  assert.equal(calls.graphSent.length, 1, 'one reply per conversation');
  await owner.put('/api/intake/settings', { autoReplyEnabled: false });
});

test('Claude reader: official SDK, structured output, server-side fallbacks on Opus', async () => {
  await owner.put('/api/intake/settings', { aiProvider: 'claude', claudeApiKey: 'claude-test-key', claudeModel: 'claude-opus-5-5' });
  const res = await owner.post('/api/intake/panel/read', (() => {
    const form = new FormData();
    form.append('text', 'Please send 2500 pcs of polly bag');
    return form;
  })());
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.data.status, 'needs_review');
  assert.equal(res.data.data.proposal.lines[0].quantity, 2500);
  const call = calls.claude.at(-1);
  assert.equal(call.headers['x-api-key'], 'claude-test-key');
  assert.match(call.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(call.json.fallbacks, 'default');
  assert.equal(call.json.output_config.format.type, 'json_schema');
  assert.equal(res.data.data.readings.at(-1).provider, 'claude');
});

test('fallback provider is used when the main one fails; usage is logged', async () => {
  await owner.put('/api/intake/settings', { aiProvider: 'openai', openaiBaseUrl: `http://127.0.0.1:${fake.address().port}/openai`, openaiModel: 'llama', aiFallbackProvider: 'gemini' });
  const form = new FormData();
  form.append('text', 'need 900 pcs bags');
  const res = await owner.post('/api/intake/panel/read', form);
  assert.equal(res.status, 201);
  assert.equal(res.data.data.readings.at(-1).provider, 'gemini');
  assert.ok(res.data.data.warnings.some((w) => /openai failed/i.test(w)));
  const usage = (await owner.get('/api/intake/settings')).data.data.usage;
  assert.ok(usage.today >= 2);
  await owner.put('/api/intake/settings', { aiProvider: 'gemini', aiFallbackProvider: '' });
});

test('daily reading limit: drafts wait for tomorrow instead of failing', async () => {
  await owner.put('/api/intake/settings', { dailyReadLimit: 1 });
  await webhook(waMessage('919000000006', 'order 400 pcs'));
  await jobs.drain();
  const draft = await intakes().findOne({ conversationKey: '919000000006' });
  assert.equal(draft.status, 'received');
  assert.match(draft.error, /daily reading limit/i);
  const job = await db.collection('jobs').findOne({ type: 'intake:read', 'payload.intakeId': String(draft._id) });
  assert.equal(job.status, 'pending');
  assert.ok(job.runAt > new Date());
  await owner.put('/api/intake/settings', { dailyReadLimit: 200 });
  await db.collection('jobs').updateOne({ _id: job._id }, { $set: { runAt: new Date() } });
  await jobs.drain();
  assert.equal((await intakes().findOne({ _id: draft._id })).status, 'needs_review');
});

test('Gmail: one draft per thread, quoted text removed, own and bulk mail skipped', async () => {
  const gmail = require('../src/modules/intake/intake.gmail');
  await db.collection('intakesettings').updateOne({ key: 'default' }, { $set: { gmailClientId: 'id', gmailEmail: 'sales@ourplant.example' } });
  const settingsModule = require('../src/modules/intake/intake.settings');
  await settingsModule.updateSettingsFields({ gmailClientSecret: 'secret', gmailRefreshToken: 'refresh' });
  const b64 = (text) => Buffer.from(text).toString('base64url');
  const messages = {
    m1: { threadId: 't1', from: 'Raj <raj@abcindustries.example>', subject: 'PO for bags', text: 'Please supply 6000 pcs polly bag' },
    m2: { threadId: 't1', from: 'Raj <raj@abcindustries.example>', subject: 'Re: PO for bags', text: 'Delivery by Friday please\n\nOn Mon, 12 Oct 2026, Sales wrote:\n> old quoted order text 9999 pcs' },
    m3: { threadId: 't2', from: 'Sales <sales@ourplant.example>', subject: 'order confirmation', text: 'our own mail' },
    m4: { threadId: 't3', from: 'News <news@vendor.example>', subject: 'Monthly order offers', text: 'newsletter', bulk: true },
  };
  gmail.setClientFactory(() => ({
    users: {
      messages: {
        get: async ({ id }) => {
          const m = messages[id];
          const headers = [
            { name: 'From', value: m.from },
            { name: 'Subject', value: m.subject },
            { name: 'Message-ID', value: `<${id}@mail.example>` },
            ...(m.bulk ? [{ name: 'List-Unsubscribe', value: '<mailto:x@y>' }] : []),
          ];
          return { data: { id, threadId: m.threadId, labelIds: ['INBOX'], internalDate: String(Date.now()), payload: { mimeType: 'text/plain', headers, body: { data: b64(m.text) } } } };
        },
        modify: async () => ({}),
      },
      labels: { list: async () => ({ data: { labels: [{ id: 'L1', name: 'Potential order' }] } }) },
    },
  }));
  try {
    for (const id of Object.keys(messages)) await gmail.fetchMessage({ messageId: id });
    await jobs.drain();
  } finally {
    gmail.setClientFactory(null);
  }
  const threads = await intakes().find({ channel: 'gmail' }).toArray();
  const t1 = threads.find((d) => d.conversationKey === 't1');
  assert.equal(t1.messages.length, 2);
  assert.ok(!t1.rawBody.includes('9999'), 'quoted text removed');
  assert.equal(t1.status, 'needs_review');
  assert.equal(threads.some((d) => d.conversationKey === 't2'), false, 'own mail skipped');
  const t3 = threads.find((d) => d.conversationKey === 't3');
  assert.equal(t3.potentialOrder, false, 'bulk mail is not an order');
  assert.equal(t3.status, 'stored');
  assert.equal(t3.messages[0].automated, true);
});

test('retention: old non-order mail keeps only sender, subject and date', async () => {
  const t3 = await intakes().findOne({ conversationKey: 't3' });
  await intakes().updateOne({ _id: t3._id }, { $set: { lastMessageAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) } });
  await require('../src/modules/intake/intake.service').removeOldBodies();
  const after = await intakes().findOne({ _id: t3._id });
  assert.equal(after.rawBody, '');
  assert.equal(after.messages[0].body, '');
  assert.equal(after.subject, 'Monthly order offers');
  assert.ok(after.bodyRemovedAt);
});

test('list pages on the server with counts, and the summary counts drafts waiting for review', async () => {
  const page = (await owner.get('/api/intake?page=1&pageSize=2&status=review')).data.data;
  assert.ok(page.items.length <= 2);
  assert.ok(page.counts.review >= 1);
  assert.equal(page.items[0].rawBody, undefined, 'list rows are light');
  const summary = (await owner.get('/api/intake/summary')).data.data;
  assert.equal(summary.needsReview, page.counts.review);
});

test('a restart re-queues drafts left mid-read', async () => {
  await webhook(waMessage('919000000007', 'order 800 pcs'));
  const jobQueue = db.collection('jobs');
  // Simulate a crash: the ingest job ran, the read job and its lock are gone.
  await jobs.tick({ wait: true });
  const draft = await intakes().findOne({ conversationKey: '919000000007' });
  await intakes().updateOne({ _id: draft._id }, { $set: { status: 'reading' } });
  await jobQueue.deleteMany({ type: 'intake:read', 'payload.intakeId': String(draft._id) });
  assert.ok((await require('../src/modules/intake/intake.service').recoverStuck()) >= 1);
  await jobs.drain();
  assert.equal((await intakes().findOne({ _id: draft._id })).status, 'needs_review');
});
