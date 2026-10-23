const fs = require('fs');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const h = require('./helpers');

let db;
before(async () => {
  ({ db } = await h.startApp());
});
after(h.stopApp);

const settle = () => new Promise((r) => setTimeout(r, 400));

async function bearer(token, method, url, body) {
  const res = await fetch(`${h.baseUrl}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

test('accounts can read suppliers (purchase forms) but not change them', async () => {
  const accounts = await h.signIn('accounts', h.DEMO_PASSWORD);
  const list = await accounts.get('/api/suppliers');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data.data));
  if (list.data.data[0]) assert.equal((await accounts.get(`/api/suppliers/${list.data.data[0].id}`)).status, 200);
  assert.equal((await accounts.post('/api/suppliers', { name: 'Not allowed' })).status, 403);
});

test('failed logins from one address do not lock the user out from another', async () => {
  const from = (ip) => ({ 'Content-Type': 'application/json', 'X-Forwarded-For': ip });
  let last;
  for (let i = 0; i < 11; i += 1) {
    last = await fetch(`${h.baseUrl}/api/auth/login`, { method: 'POST', headers: from('203.0.113.7'), body: JSON.stringify({ username: 'sales', password: 'wrong' }) });
  }
  assert.equal(last.status, 429);
  const real = await fetch(`${h.baseUrl}/api/auth/login`, { method: 'POST', headers: from('198.51.100.20'), body: JSON.stringify({ username: 'sales', password: h.DEMO_PASSWORD }) });
  assert.equal(real.status, 200);
});

test('user directory leaves out Super Admins and sign-in names', async () => {
  const production = await h.signIn('production', h.DEMO_PASSWORD);
  const res = await production.get('/api/users/directory');
  assert.equal(res.status, 200);
  assert.ok(res.data.data.length > 0);
  assert.ok(res.data.data.every((u) => u.role?.slug !== 'super_admin'));
  assert.ok(res.data.data.every((u) => u.username === undefined));
  assert.ok(res.data.data.every((u) => u.id && u.fullName));
});

test('sign-out ends the access token at once; a password reset ends all of them', async () => {
  const first = await h.login('dispatch');
  const token = first.body.data.accessToken;
  assert.equal(await bearer(token, 'GET', '/api/auth/me'), 200);
  const session = h.client(first.cookies);
  assert.equal((await session.post('/api/auth/logout', {})).status, 200);
  assert.equal(await bearer(token, 'GET', '/api/auth/me'), 401, 'signed-out token still works');

  const second = await h.login('dispatch');
  const token2 = second.body.data.accessToken;
  const owner = await h.signIn('owner', h.OWNER_PASSWORD);
  const user = await db.collection('users').findOne({ username: 'dispatch' });
  assert.equal((await owner.patch(`/api/users/${user._id}`, { password: 'NewDispatch#2026' })).status, 200);
  assert.equal(await bearer(token2, 'GET', '/api/auth/me'), 401, 'token from before the reset still works');
  assert.equal((await h.client(second.cookies).post('/api/auth/refresh', {})).status, 401);
  assert.equal((await h.login('dispatch', 'NewDispatch#2026')).status, 200);

  // Sign out everywhere.
  const a = await h.login('dispatch', 'NewDispatch#2026');
  const b = h.client((await h.login('dispatch', 'NewDispatch#2026')).cookies);
  assert.equal((await b.post('/api/auth/logout-all', {})).status, 200);
  assert.equal(await bearer(a.body.data.accessToken, 'GET', '/api/auth/me'), 401);
});

test('changing your own password needs the current one, and keeps you signed in', async () => {
  const owner = await h.signIn('owner', h.OWNER_PASSWORD);
  const perms = await db.collection('permissions').find({ key: { $in: ['users:read', 'users:update'] } }).toArray();
  const role = await db.collection('roles').insertOne({ name: 'Self change test', slug: 'self_change_test', permissions: perms.map((p) => p._id), createdAt: new Date(), updatedAt: new Date() });
  assert.equal((await owner.post('/api/users', { username: 'selfchange', password: 'SelfChange#2026', fullName: 'Self Change', roleId: String(role.insertedId) })).status, 201);
  const me = await h.signIn('selfchange', 'SelfChange#2026');
  const id = String((await db.collection('users').findOne({ username: 'selfchange' }))._id);

  assert.equal((await me.patch(`/api/users/${id}`, { password: 'Taken#over2026' })).status, 400, 'no current password');
  assert.equal((await me.patch(`/api/users/${id}`, { password: 'Taken#over2026', currentPassword: 'wrong-one' })).status, 400, 'wrong current password');
  assert.equal((await me.patch(`/api/users/${id}`, { password: 'Changed#2026', currentPassword: 'SelfChange#2026' })).status, 200);
  assert.equal((await me.get('/api/auth/me')).status, 200, 'this browser stays signed in');
  assert.equal((await h.login('selfchange', 'Changed#2026')).status, 200);
});

test('company bank details and PAN only go to accounts / sales / owner', async () => {
  const owner = await h.signIn('owner', h.OWNER_PASSWORD);
  assert.equal((await owner.put('/api/company-settings', { bankAccountNumber: '1234567890', bankIfsc: 'HDFC0000001', pan: 'ABCDE1234F' })).status, 200);
  const rolling = await h.signIn('rolling', h.DEMO_PASSWORD);
  const floor = (await rolling.get('/api/company-settings')).data.data;
  assert.equal(floor.bankAccountNumber, undefined);
  assert.equal(floor.bankIfsc, undefined);
  assert.equal(floor.pan, undefined);
  assert.ok(floor.legalName);
  const accounts = await h.signIn('accounts', h.DEMO_PASSWORD);
  assert.equal((await accounts.get('/api/company-settings')).data.data.bankAccountNumber, '1234567890');
});

test('audit log: unknown /api/auth calls are not logged, sign-out is', async () => {
  await settle();
  const before = await db.collection('auditlogs').countDocuments({ module: 'Login' });
  await fetch(`${h.baseUrl}/api/auth/nothing-here`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await fetch(`${h.baseUrl}/api/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await settle();
  assert.equal(await db.collection('auditlogs').countDocuments({ module: 'Login' }), before, 'anonymous noise was logged');
  const session = await h.signIn('sales', h.DEMO_PASSWORD);
  await session.post('/api/auth/logout', {});
  await settle();
  assert.ok(await db.collection('auditlogs').findOne({ module: 'Login', action: 'logged out', actorName: { $ne: '' } }));
});

test('uploads: only public folders are served, encoded paths included', async () => {
  const root = process.env.UPLOADS_DIR;
  for (const folder of ['products', 'sales-orders/abc', 'intake']) {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, folder, 'x.png'), 'png');
  }
  assert.equal((await fetch(`${h.baseUrl}/uploads/products/x.png`)).status, 200);
  for (const url of ['/uploads/sales-orders/abc/x.png', '/uploads/sales%2Dorders/abc/x.png', '/uploads/%69ntake/x.png', '/uploads/intake/x.png', '/uploads/products/..%2Fintake/x.png', '/uploads/products%5C..%5Cintake/x.png']) {
    assert.equal((await fetch(`${h.baseUrl}${url}`)).status, 404, url);
  }
});

test('photos: an outside url keeps no key or storage, private paths go, our own keeps a rebuilt key', () => {
  const { sanitizeImageRef, storeProductPhotos } = require('../src/utils/inlineImages');
  const evil = sanitizeImageRef({ url: 'https://evil.example/x.png', key: 'sales-orders/1/po.pdf', storage: 's3', originalName: 'x.png' });
  assert.equal(evil.url, 'https://evil.example/x.png', 'a saved photo link is never erased');
  assert.equal(evil.key, undefined);
  assert.equal(evil.storage, undefined);
  const ours = sanitizeImageRef({ url: '/uploads/products/1-a.png', key: 'intake/secret.pdf', storage: 's3' });
  assert.deepEqual([ours.url, ours.key, ours.storage], ['/uploads/products/1-a.png', 'products/1-a.png', 'local']);
  assert.equal(sanitizeImageRef({ url: '/uploads/intake/a.png' }).url, '');
  const product = { images: [{ url: 'https://elsewhere.example/p.png', key: 'intake/secret.pdf', storage: 's3' }] };
  return storeProductPhotos(product).then((changed) => {
    assert.equal(changed, true);
    assert.equal(product.images[0].key, undefined, 'the server never treats it as its own file');
  });
});

test('uploads larger than the request limit are refused before reading', async () => {
  const owner = await h.signIn('owner', h.OWNER_PASSWORD);
  const form = new FormData();
  form.append('folder', 'misc');
  form.append('file', new Blob([Buffer.alloc(26 * 1024 * 1024)]), 'big.pdf');
  const res = await owner.post('/api/media', form).catch((error) => ({ status: 0, error }));
  assert.ok([413, 0].includes(res.status), `status ${res.status}`);
  if (res.status) assert.equal(res.status, 413);
});

test('open-model reader: the saved key is dropped when the server address changes', async () => {
  const owner = await h.signIn('owner', h.OWNER_PASSWORD);
  assert.equal((await owner.put('/api/intake/settings', { openaiBaseUrl: 'https://models.example.com/v1', openaiApiKey: 'sk-test-1' })).status, 200);
  let view = (await owner.get('/api/intake/settings')).data.data;
  assert.equal(view.openaiApiKeySet, true);
  // Other fields saved: key kept.
  await owner.put('/api/intake/settings', { openaiBaseUrl: 'https://models.example.com/v1', openaiModel: 'llama' });
  assert.equal((await owner.get('/api/intake/settings')).data.data.openaiApiKeySet, true);
  // New address without a new key: key gone.
  await owner.put('/api/intake/settings', { openaiBaseUrl: 'https://attacker.example.net/v1' });
  view = (await owner.get('/api/intake/settings')).data.data;
  assert.equal(view.openaiApiKeySet, false);
  // New address with a new key: kept.
  await owner.put('/api/intake/settings', { openaiBaseUrl: 'https://models.example.com/v1', openaiApiKey: 'sk-test-2' });
  assert.equal((await owner.get('/api/intake/settings')).data.data.openaiApiKeySet, true);
  assert.equal((await owner.put('/api/intake/settings', { openaiBaseUrl: 'ftp://models.example.com' })).status, 400);

  const { checkBaseUrl } = require('../src/modules/intake/ai/openaiCompatible');
  const strict = { allowPrivate: false };
  assert.ok(checkBaseUrl('http://models.example.com/v1', strict));
  for (const url of ['https://127.0.0.1/v1', 'https://localhost:11434', 'https://10.1.2.3', 'https://192.168.1.5', 'https://169.254.169.254', 'https://[::1]/', 'https://user:pw@models.example.com']) {
    assert.ok(checkBaseUrl(url, strict), url);
  }
  assert.equal(checkBaseUrl('https://api.groq.com/openai/v1', strict), '');
});

test('Gmail OAuth state is bound to the user who started it', async () => {
  const settings = require('../src/modules/intake/intake.settings');
  const gmail = require('../src/modules/intake/intake.gmail');
  await settings.updateSettingsFields({ gmailClientId: 'client-id', gmailClientSecret: 'client-secret', publicBaseUrl: 'https://erp.example.com' });
  const owner = await db.collection('users').findOne({ username: 'owner' });
  const url = await gmail.startUrl({ _id: owner._id });
  const state = new URL(url).searchParams.get('state');
  assert.ok(state);
  await assert.rejects(gmail.finishCallback('code', state, String(h.asId('0123456789abcdef01234567'))), /another user/);
  // An access token (same secret, no audience) is not a valid state.
  const accessLike = jwt.sign({ purpose: 'gmail', sub: String(owner._id) }, process.env.JWT_ACCESS_SECRET);
  await assert.rejects(gmail.finishCallback('code', accessLike, ''), /expired/);
  // And a state is not a valid access token.
  assert.equal(await bearer(state, 'GET', '/api/auth/me'), 401);
  await assert.rejects(gmail.startUrl(null), /Sign in/);
});
