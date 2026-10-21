// Shared setup for the API tests.
//
// The tests WIPE the database they run against, so they only run with
// TEST_MONGO_URI pointing at a MongoDB on localhost, e.g.
//   TEST_MONGO_URI="mongodb://127.0.0.1:27017/sinopec_test?directConnection=true" npm test
// A single-node replica set (mongod --replSet rs0, then rs.initiate()) also
// exercises the transaction tests; on a standalone mongod those are skipped.
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_URI = process.env.TEST_MONGO_URI || '';
const local = /^mongodb:\/\/(?:[^@/]*@)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?]|$)/i.test(TEST_URI);
if (!local) {
  throw new Error('Set TEST_MONGO_URI to a MongoDB on localhost. The tests wipe that database; they never run against .env.');
}

// Everything the app reads from the environment is pinned before any app
// module loads (dotenv never overrides variables that are already set), so
// nothing here can reach the real database, S3 or mail.
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinopec-test-uploads-'));
Object.assign(process.env, {
  MONGO_URI: TEST_URI,
  MONGODB_URI: TEST_URI,
  NODE_ENV: 'test',
  CLIENT_ORIGIN: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'test-only-access-secret-0123456789',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-0123456789',
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '7d',
  SUPERADMIN_USERNAME: 'owner',
  SUPERADMIN_PASSWORD: 'TestOwner#2026',
  AWS_ACCESS_KEY_ID: '',
  AWS_SECRET_ACCESS_KEY: '',
  AWS_REGION: '',
  AWS_S3_BUCKET_NAME: '',
  S3_BUCKET: '',
  CLOUDFRONT_DOMAIN: '',
  S3_PUBLIC_URL: '',
  UPLOADS_DIR: uploadsDir,
  TASK_RECONCILE_MINUTES: '0',
  DNS_SERVERS: '',
});

const mongoose = require('mongoose');
const { connectDb } = require('../src/config/db');
const app = require('../src/app');
const { seed } = require('../src/seeders/seed');

const OWNER_PASSWORD = process.env.SUPERADMIN_PASSWORD;
const DEMO_PASSWORD = 'Demo@1234';

let server;
let baseUrl;

// Fresh database with the demo data, and the API on a random local port.
async function startApp() {
  await connectDb();
  await mongoose.connection.db.dropDatabase();
  // Dropping the database also drops the indexes built at start-up; build
  // them again so unique rules behave as they do on the real database.
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
  const quiet = console.log;
  console.log = () => {};
  try {
    await seed();
  } finally {
    console.log = quiet;
  }
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { db: mongoose.connection.db, baseUrl };
}

async function stopApp() {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()));
  await mongoose.disconnect();
  fs.rmSync(uploadsDir, { recursive: true, force: true });
}

function cookiesFrom(res) {
  return res.headers.getSetCookie().map((cookie) => cookie.split(';')[0]);
}

async function login(username, password = DEMO_PASSWORD) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, raw: res.headers.getSetCookie(), cookies: cookiesFrom(res) };
}

// A signed-in client that keeps its cookie jar up to date (refresh rotates it).
function client(cookies) {
  let jar = [...cookies];
  async function call(method, url, body) {
    const isForm = body instanceof FormData;
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Cookie: jar.filter((c) => !/=$/.test(c)).join('; '),
      },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
    const set = cookiesFrom(res);
    if (set.length) {
      const map = new Map(jar.map((c) => [c.split('=')[0], c]));
      for (const c of set) map.set(c.split('=')[0], c);
      jar = [...map.values()];
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, set, headers: res.headers };
  }
  return {
    get jar() {
      return jar;
    },
    get: (url) => call('GET', url),
    post: (url, body) => call('POST', url, body),
    patch: (url, body) => call('PATCH', url, body),
    put: (url, body) => call('PUT', url, body),
    del: (url, body) => call('DELETE', url, body),
  };
}

async function signIn(username, password) {
  const result = await login(username, password);
  if (result.status !== 200) throw new Error(`login ${username} failed: ${result.status} ${JSON.stringify(result.body)}`);
  return client(result.cookies);
}

const asId = (value) => new mongoose.Types.ObjectId(String(value));

module.exports = {
  startApp,
  stopApp,
  login,
  client,
  signIn,
  asId,
  get baseUrl() {
    return baseUrl;
  },
  OWNER_PASSWORD,
  DEMO_PASSWORD,
};
