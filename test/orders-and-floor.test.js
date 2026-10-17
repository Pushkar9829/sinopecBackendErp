const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
let orders;
let lots;
before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
  orders = db.collection('salesorders');
  lots = db.collection('inventoryitems');
});
after(h.stopApp);

const ok2xx = (r) => r.status >= 200 && r.status < 300;

test('two payments for 60% of the balance at once: exactly one is accepted', async () => {
  const order = await orders.findOne({ status: { $nin: ['draft', 'cancelled'] }, remainingAmount: { $gt: 100 } });
  const amount = Math.floor(order.remainingAmount * 0.6);
  const results = await Promise.all([1, 2].map(() => owner.post(`/api/sales-orders/${order._id}/payments`, { amount, method: 'bank_transfer' })));
  assert.equal(results.filter(ok2xx).length, 1, results.map((r) => r.status).join('/'));
  const saved = await orders.findOne({ _id: order._id });
  const sum = saved.payments.filter((p) => !p.voidedAt).reduce((s, p) => s + p.amount, 0);
  assert.ok(Math.abs(sum - saved.paidAmount) < 0.01);
});

// Plans an approved/submitted order so there is a fresh job on the floor.
async function freshFloorJob() {
  for (const order of await orders.find({ status: { $in: ['approved', 'submitted'] } }).toArray()) {
    if (order.status === 'submitted') await owner.post(`/api/sales-orders/${order._id}/approve`);
    if ((await owner.post(`/api/sales-orders/${order._id}/plan-production`)).status === 200) break;
  }
  const undispatched = new Set((await orders.find({ 'items.stageWork.stage': { $ne: 'dispatch' } }).project({ _id: 1 }).toArray()).map((o) => String(o._id)));
  for (const stage of ['rolling', 'printing', 'cutting']) {
    const queue = await owner.get(`/api/production/queue?stage=${stage}`);
    const job = (queue.data.data.jobs || []).find((j) => !j.pickup && undispatched.has(j.orderId) && j.sourceLots?.some((l) => l.quantity >= 5));
    if (job) return { job, stage };
  }
  throw new Error('no floor job with stock');
}

test('concurrent pickups and a double cancel keep stock exact', async () => {
  const { job, stage } = await freshFloorJob();
  const lot = job.sourceLots.find((l) => l.quantity >= 5);
  const lotBefore = await lots.findOne({ _id: h.asId(lot.id) });
  await Promise.all([1, 2].map(() => owner.post('/api/production/pickup', { orderId: job.orderId, itemId: job.itemId, stage, lotId: lot.id, qty: 1 })));
  const order = await orders.findOne({ _id: h.asId(job.orderId) });
  const item = order.items.find((i) => String(i._id) === job.itemId);
  const taken = lotBefore.quantity - (await lots.findOne({ _id: lotBefore._id })).quantity;
  assert.ok(Math.abs(taken - item.stagePickup.qty) < 1e-6, `taken ${taken}, on order ${item.stagePickup.qty}`);

  const held = item.stagePickup.qty;
  const stockBefore = (await lots.findOne({ _id: lotBefore._id })).quantity;
  await orders.updateOne({ _id: order._id }, { $set: { payments: [], paidAmount: 0 } });
  const cancels = await Promise.all([1, 2].map(() => owner.post(`/api/sales-orders/${job.orderId}/cancel`, { reason: 'race test' })));
  assert.equal(cancels.filter(ok2xx).length, 1, cancels.map((r) => r.status).join('/'));
  const stockAfter = (await lots.findOne({ _id: lotBefore._id })).quantity;
  assert.ok(Math.abs(stockAfter - stockBefore - held) < 1e-6, 'stock returned exactly once');
});

test('a stale inventory form cannot overwrite floor stock movements', async () => {
  const raw = await lots.findOne({ category: 'raw', kind: { $ne: 'wip' }, quantity: { $gt: 10 }, isActive: true });
  await lots.updateOne({ _id: raw._id }, { $inc: { quantity: -3 } });
  assert.equal((await owner.patch(`/api/inventory/items/${raw._id}`, { quantity: raw.quantity + 5, expectedQuantity: raw.quantity })).status, 409);
  assert.equal((await owner.patch(`/api/inventory/items/${raw._id}`, { notes: 'renamed only' })).status, 200);
  const now = await lots.findOne({ _id: raw._id });
  assert.ok(Math.abs(now.quantity - (raw.quantity - 3)) < 1e-9);
});

test('GST is charged after the order discount', async () => {
  const draft = await orders.findOne({ status: 'draft' });
  const res = await owner.patch(`/api/sales-orders/${draft._id}`, {
    discount: 100,
    items: [{ ...draft.items[0], id: String(draft.items[0]._id), quantity: 10, rate: 100, discount: 0, taxPercent: 18 }],
  });
  assert.equal(res.status, 200, res.data.message);
  assert.ok(Math.abs(res.data.data.grandTotal - 1062) < 0.01);
});

test('a user without price access cannot wipe prices when saving a draft', async () => {
  const salesUpdate = await db.collection('permissions').findOne({ key: 'sales:update' });
  const role = await db.collection('roles').insertOne({ name: 'Draft editor test', slug: 'draft_editor_test', permissions: [salesUpdate._id], createdAt: new Date(), updatedAt: new Date() });
  await owner.post('/api/users', { username: 'drafteditor', password: 'Drafteditor#2026', fullName: 'Draft Editor', roleId: String(role.insertedId) });
  const editor = await h.signIn('drafteditor', 'Drafteditor#2026');
  const draft = await orders.findOne({ status: 'draft' });
  await editor.patch(`/api/sales-orders/${draft._id}`, { discount: 0, items: draft.items.map((it) => ({ ...it, id: String(it._id), rate: 0, discount: 0 })) });
  const after = await orders.findOne({ _id: draft._id });
  assert.equal(after.items[0].rate, draft.items[0].rate);
  assert.equal(after.discount, draft.discount);
});

test('payments are voided with a reason, and an order with active payments cannot be cancelled', async () => {
  const order = await orders.findOne({ status: { $in: ['submitted', 'approved'] } });
  const paid = await owner.post(`/api/sales-orders/${order._id}/payments`, { amount: 10, method: 'bank_transfer' });
  const payment = paid.data.data.payments.at(-1);
  const blocked = await owner.post(`/api/sales-orders/${order._id}/cancel`, { reason: 'x' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.message, /payments/i);
  assert.equal((await owner.del(`/api/sales-orders/${order._id}/payments/${payment.id}`, {})).status, 400, 'reason required');
  const voided = await owner.del(`/api/sales-orders/${order._id}/payments/${payment.id}`, { reason: 'entered twice' });
  assert.equal(voided.status, 200);
  const kept = voided.data.data.payments.find((p) => p.id === payment.id);
  assert.ok(kept.voidedAt);
  assert.equal(kept.voidReason, 'entered twice');
  assert.equal(voided.data.data.paidAmount, paid.data.data.paidAmount - 10);
  assert.equal((await owner.post(`/api/sales-orders/${order._id}/cancel`, { reason: 'x' })).status, 200);
});

test('order attachments are private and POs are commercial-only', async () => {
  const order = await orders.findOne({ status: 'in_production' });
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4 test purchase order')], { type: 'image/png' }), 'customer-po.pdf');
  form.append('kind', 'po');
  const up = await owner.post(`/api/sales-orders/${order._id}/attachments`, form);
  const att = up.data.data.attachments.find((a) => a.originalName === 'customer-po.pdf');
  assert.equal(att.url, undefined);
  assert.equal(att.key, undefined);
  const stored = (await orders.findOne({ _id: order._id })).attachments.find((a) => a.originalName === 'customer-po.pdf');
  assert.equal(stored.mimeType, 'application/pdf', 'type from extension, not the client');
  assert.equal((await fetch(`${h.baseUrl}${stored.url}`)).status, 404, 'not served publicly');
  const dl = await owner.get(`/api/sales-orders/${order._id}/attachments/${att.id}/file`);
  assert.equal(dl.status, 200);
  const production = await h.signIn('production');
  assert.equal((await production.get(`/api/sales-orders/${order._id}/attachments/${att.id}/file`)).status, 403);
  const view = await production.get(`/api/sales-orders/${order._id}`);
  assert.ok(!view.data.data.attachments.some((a) => a.kind === 'po'));
});

test('order rules: date window, no files on delivered orders, raw material must match', async () => {
  const draft = await orders.findOne({ status: 'draft' });
  assert.equal((await owner.patch(`/api/sales-orders/${draft._id}`, { orderDate: '1999-01-01' })).status, 400);
  const delivered = await orders.findOne({ status: 'delivered' });
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4 x')], { type: 'application/pdf' }), 'late.pdf');
  form.append('kind', 'other');
  assert.equal((await owner.post(`/api/sales-orders/${delivered._id}/attachments`, form)).status, 400);

  const production = await h.signIn('production');
  const job = ((await production.get('/api/production/queue?stage=rolling')).data.data.jobs || [])[0];
  const wrong = await lots.findOne({ category: 'raw', kind: { $ne: 'wip' }, name: /ink|carton/i, quantity: { $gt: 1 } });
  if (job && wrong) {
    const pick = await production.post('/api/production/pickup', { orderId: job.orderId, itemId: job.itemId, stage: 'rolling', lotId: String(wrong._id), qty: 1 });
    assert.equal(pick.status, 400);
  }
});

test('photos sent inline are stored as files; the order keeps only the link', async () => {
  const draft = await orders.findOne({ status: 'draft' });
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  const res = await owner.patch(`/api/sales-orders/${draft._id}`, {
    items: [{ ...draft.items[0], id: String(draft.items[0]._id), image: { dataUrl: png, originalName: 'p.png' }, images: [{ dataUrl: png, originalName: 'p.png' }] }],
  });
  assert.equal(res.status, 200, res.data.message);
  const saved = await orders.findOne({ _id: draft._id });
  assert.equal(saved.items[0].image.dataUrl, '');
  assert.match(saved.items[0].image.url, /^\/uploads\/products\//);
});

test('floor error messages round quantities', async () => {
  const { job, stage } = await freshFloorJob();
  const res = await owner.post('/api/production/pickup', { orderId: job.orderId, itemId: job.itemId, stage, lotId: job.sourceLots[0].id, qty: 1e9 });
  assert.equal(res.status, 400);
  assert.doesNotMatch(res.data.message, /\d\.\d{4,}/);
});
