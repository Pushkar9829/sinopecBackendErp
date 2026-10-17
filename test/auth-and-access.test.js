const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
before(async () => {
  ({ db } = await h.startApp());
});
after(h.stopApp);

test('login: access token in body, refresh token only in an httpOnly Lax cookie', async () => {
  const owner = await h.login('owner', h.OWNER_PASSWORD);
  assert.equal(owner.status, 200);
  assert.ok(owner.body.data.accessToken);
  assert.equal(owner.body.data.refreshToken, undefined);
  assert.ok(owner.raw.some((c) => /refresh/i.test(c) && /httponly/i.test(c)));
  assert.ok(owner.raw.every((c) => /samesite=lax/i.test(c)));
});

test('two logins in the same second both work (unique token ids)', async () => {
  const [a, b] = await Promise.all([h.login('sales'), h.login('sales')]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});

test('refresh rotation: replay inside the grace window is refused without logging the winner out', async () => {
  const session = h.client((await h.login('owner', h.OWNER_PASSWORD)).cookies);
  const oldJar = session.jar.slice();
  assert.equal((await session.post('/api/auth/refresh', {})).status, 200);
  const replay = await h.client(oldJar).post('/api/auth/refresh', {});
  assert.equal(replay.status, 401);
  assert.ok(!replay.set.some((c) => /=$/.test(c)), 'grace replay must not clear cookies');
  assert.equal((await session.get('/api/auth/me')).status, 200);

  // An old token replayed after the grace window revokes the whole family.
  await db.collection('refreshtokens').updateMany({ revokedAt: { $ne: null } }, { $set: { revokedAt: new Date(Date.now() - 60_000) } });
  assert.equal((await h.client(oldJar).post('/api/auth/refresh', {})).status, 401);
  assert.equal((await session.post('/api/auth/refresh', {})).status, 401);
});

test('refresh token sent in the body is ignored', async () => {
  const res = await fetch(`${h.baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: 'x.y.z' }),
  });
  assert.equal(res.status, 401);
});

test('CORS: exact origins only', async () => {
  for (const [origin, allowed] of [
    ['https://sinopecerpfrontend-evil.vercel.app', false],
    ['https://evil-pushkar9829s-projects.vercel.app', false],
    ['http://localhost:5173', true],
  ]) {
    const res = await fetch(`${h.baseUrl}/api/health`, { headers: { Origin: origin } });
    const acao = res.headers.get('access-control-allow-origin');
    if (allowed) assert.equal(acao, origin);
    else assert.equal(acao, null, origin);
  }
});

test('login rate limit: 11th failed attempt for a user is 429, other users unaffected', async () => {
  let last;
  for (let i = 0; i < 11; i += 1) last = await h.login('accounts', 'wrong-password');
  assert.equal(last.status, 429);
  assert.equal((await h.login('dispatch')).status, 200);
});

test('a user manager cannot reach beyond their own access', async () => {
  const owner = await h.signIn('owner', h.OWNER_PASSWORD);
  const perms = await db.collection('permissions').find({ key: { $in: ['users:read', 'users:create', 'users:update', 'roles:read', 'roles:update'] } }).toArray();
  const role = await db.collection('roles').insertOne({ name: 'User admin test', slug: 'user_admin_test', permissions: perms.map((p) => p._id), createdAt: new Date(), updatedAt: new Date() });
  assert.equal((await owner.post('/api/users', { username: 'useradmin', password: 'Useradmin#2026', fullName: 'User Admin', roleId: String(role.insertedId) })).status, 201);
  const mgr = await h.signIn('useradmin', 'Useradmin#2026');

  const prodUser = await db.collection('users').findOne({ username: 'production' });
  assert.equal((await mgr.patch(`/api/users/${prodUser._id}`, { password: 'Hijacked#2026' })).status, 403, 'reset a stronger user');
  const salesRole = await db.collection('roles').findOne({ slug: 'sales_manager' });
  assert.equal((await mgr.post('/api/users', { username: 'escalate1', password: 'Escalate#2026', fullName: 'X', roleId: String(salesRole._id) })).status, 403, 'hand out a stronger role');
  const all = (await db.collection('permissions').find({}).toArray()).map((p) => String(p._id));
  assert.equal((await mgr.patch(`/api/roles/${role.insertedId}/permissions`, { permissionIds: all })).status, 403, 'edit own role');
  assert.equal((await mgr.patch(`/api/roles/${salesRole._id}/permissions`, { permissionIds: all })).status, 403, 'grant beyond own access');
});

test('"false" as text really means false', async () => {
  const owner = await h.signIn('owner', h.OWNER_PASSWORD);
  const me = await db.collection('users').findOne({ username: 'owner' });
  assert.equal((await owner.patch(`/api/users/${me._id}`, { isActive: 'false' })).status, 400, 'cannot deactivate yourself via "false"');
  const customer = await db.collection('customers').findOne({});
  assert.equal((await owner.patch(`/api/customers/${customer._id}`, { isActive: 'false' })).status, 200);
  assert.equal((await db.collection('customers').findOne({ _id: customer._id })).isActive, false);
  await db.collection('customers').updateOne({ _id: customer._id }, { $set: { isActive: true } });
});

test('anonymous requests are rejected and not written to the audit log', async () => {
  await new Promise((r) => setTimeout(r, 500)); // let earlier audit writes land
  const before = await db.collection('auditlogs').countDocuments();
  const res = await fetch(`${h.baseUrl}/api/customers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(res.status, 401);
  assert.equal(await db.collection('auditlogs').countDocuments(), before);
});

test('a renamed owner is not recreated with the default password on restart', async () => {
  const users = db.collection('users');
  await users.updateOne({ username: 'owner' }, { $set: { username: 'owner-renamed' } });
  await require('../src/seeders/seed').seedSystem();
  assert.equal(await users.findOne({ username: 'owner' }), null);
  await users.updateOne({ username: 'owner-renamed' }, { $set: { username: 'owner' } });
});
