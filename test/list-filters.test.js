const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let owner;
before(async () => {
  ({ db } = await h.startApp());
  owner = await h.signIn('owner', h.OWNER_PASSWORD);
});
after(h.stopApp);

const ist = (ymd, end) => new Date(`${ymd}T${end ? '23:59:59.999' : '00:00:00.000'}+05:30`);

test('orders list: date range on order or delivery date, priority, and sort', async () => {
  const all = await db.collection('salesorders').find({}).toArray();
  const page = async (q) => (await owner.get(`/api/sales-orders?page=1&pageSize=100&${q}`)).data.data;

  const r1 = await page('from=2026-09-20&to=2026-10-31&dateField=delivery');
  const want = all.filter((o) => o.deliveryDate && o.deliveryDate >= ist('2026-09-20') && o.deliveryDate <= ist('2026-10-31', true));
  assert.equal(r1.total, want.length);

  const high = await page('priority=high');
  assert.equal(high.total, all.filter((o) => o.priority === 'high').length);
  assert.ok(high.items.every((o) => o.priority === 'high'));

  const soonest = (await page('sort=delivery')).items.map((o) => o.deliveryDate).filter(Boolean);
  assert.deepEqual(soonest, [...soonest].sort((a, b) => new Date(a) - new Date(b)));
  const oldest = (await page('sort=oldest')).items;
  const newest = (await page('sort=newest')).items;
  assert.equal(oldest[0].id, newest[newest.length - 1].id);
});

test('tasks list: by person, nobody, priority and due dates', async () => {
  const tasks = await db.collection('tasks').find({ status: { $in: ['open', 'in_progress', 'blocked'] } }).toArray();
  const list = async (q) => (await owner.get(`/api/tasks?scope=all&page=1&pageSize=100&${q}`)).data.data;
  const someone = tasks.find((t) => t.assignee);
  if (someone) {
    const mine = await list(`assignee=${someone.assignee}`);
    assert.equal(mine.total, tasks.filter((t) => String(t.assignee) === String(someone.assignee)).length);
  }
  const nobody = await list('assignee=unassigned');
  assert.equal(nobody.total, tasks.filter((t) => !t.assignee).length);
  const urgent = await list('priority=urgent');
  assert.ok(urgent.items.every((t) => t.priority === 'urgent'));
  const dated = tasks.filter((t) => t.dueDate);
  if (dated.length) {
    const day = dated[0].dueDate.toISOString().slice(0, 10);
    const due = await list(`dueFrom=${day}&dueTo=${day}`);
    assert.ok(due.items.every((t) => t.dueDate && t.dueDate.slice(0, 10) >= day.slice(0, 8)));
    assert.ok(due.total >= 1);
  }
});

test('draft orders list: received between two days', async () => {
  const none = await owner.get('/api/intake?from=2001-01-01&to=2001-01-31');
  assert.equal(none.status, 200, JSON.stringify(none.data));
  assert.equal(none.data.data.total, 0);
  const wide = await owner.get('/api/intake?status=&from=2001-01-01&to=2099-12-31');
  const total = await db.collection('intakes').countDocuments({});
  assert.ok(wide.data.data.total <= total);
});
