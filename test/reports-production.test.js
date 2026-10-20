const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
const period = 'from=2026-01-01&to=2026-12-31';
const start = new Date('2026-01-01T00:00:00+05:30');
const end = new Date('2026-12-31T23:59:59+05:30');
const inYear = (d) => d >= start && d <= end;

before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
});
after(h.stopApp);

const work = async (stage) => {
  const orders = await db.collection('salesorders').find({ status: { $ne: 'cancelled' } }).toArray();
  return orders.flatMap((o) => (o.items || []).flatMap((i) => (i.stageWork || []).filter((w) => w.stage === stage && inYear(new Date(w.workDate))).map((w) => ({ ...w, order: o, item: i }))));
};

test('production report: output and waste per stage match the floor entries', async () => {
  const res = await owner.get(`/api/reports/production?${period}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const r = res.data.data;
  for (const stage of ['rolling', 'printing', 'cutting']) {
    const rows = await work(stage);
    const row = r.stages.find((s) => s.stage === stage);
    assert.equal(row.entries, rows.length, `${stage} entries`);
    assert.ok(Math.abs(row.output - rows.reduce((s, w) => s + (w.outputQty || 0), 0)) < 0.05, `${stage} output`);
    assert.ok(Math.abs(row.waste - rows.reduce((s, w) => s + (w.wasteQty || 0), 0)) < 0.05, `${stage} waste`);
  }
  assert.equal(r.wasteTrend.length, 12);
  const materialOutput = r.materials.reduce((s, m) => s + m.output, 0);
  assert.ok(Math.abs(materialOutput - r.stages.find((x) => x.stage === 'rolling').output) < 0.05, 'materials add up to rolling output');
  assert.equal(r.stageTimes.length, 4);
  assert.ok(r.stageTimes.every((s) => s.avgWorkDays == null || s.avgWorkDays >= 0));
});

test('work in progress lists every open line once, at the stage it is waiting at', async () => {
  const r = (await owner.get('/api/reports/production')).data.data;
  assert.equal(r.wip.reduce((s, w) => s + w.lines, 0), r.waiting.length);
  assert.equal(r.kpis.linesInProgress, r.waiting.length);
  assert.ok(r.waiting.every((w) => ['rolling', 'printing', 'cutting', 'dispatch'].includes(w.stage)));
  assert.equal(new Set(r.waiting.map((w) => w.id)).size, r.waiting.length, 'no line twice');
  // Floor reports show customer codes to everyone but the owner.
  const production = await h.signIn('production');
  const theirs = (await production.get('/api/reports/production')).data.data;
  const codes = new Set((await db.collection('salesorders').find({}).toArray()).map((o) => o.customerSnapshot?.code));
  assert.ok(theirs.waiting.every((w) => !w.customer || codes.has(w.customer)), 'codes, not names');
});

test('dispatch report: entries, deliveries and on-time count add up', async () => {
  const res = await owner.get(`/api/reports/dispatch?${period}`);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const r = res.data.data;
  const rows = await work('dispatch');
  assert.equal(r.entries.length, rows.length);
  assert.equal(r.kpis.dispatchEntries, rows.length);
  assert.equal(r.byDay.reduce((s, d) => s + d.entries, 0), rows.length);
  assert.equal(r.kpis.onTime + r.kpis.late, r.delivered.filter((d) => d.daysLate != null).length);
  assert.equal(r.monthly.reduce((s, m) => s + m.onTime + m.late + m.noDate, 0), r.kpis.delivered);
  assert.ok(r.lateNow.every((o) => o.daysLate > 0));
  assert.ok(r.dueSoon.every((o) => o.dueInDays >= 0 && o.dueInDays <= 7));
});

test('who can see the production and dispatch reports', async () => {
  const production = await h.signIn('production');
  assert.equal((await production.get('/api/reports/production')).status, 200);
  assert.equal((await production.get('/api/reports/dispatch')).status, 200);
  const dispatch = await h.signIn('dispatch');
  assert.equal((await dispatch.get('/api/reports/dispatch')).status, 200);
  assert.equal((await dispatch.get('/api/reports/production')).status, 403);
  const accounts = await h.signIn('accounts');
  assert.equal((await accounts.get('/api/reports/production')).status, 403);
  assert.equal((await accounts.get('/api/reports/dispatch')).status, 403);
});
