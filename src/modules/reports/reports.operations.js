const ApiError = require('../../utils/ApiError');
const { isSuperAdmin } = require('../../utils/permissions');
const { TASK_OPEN_STATUSES, TASK_STATUSES } = require('../../config/constants');
const Task = require('../task/task.model');
const Intake = require('../intake/intake.model');
const Role = require('../role/role.model');
const { parseRange, monthsOf, monthOf, inRange, DAY } = require('./reports.range');

const r1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const avg = (list) => (list.length ? r1(list.reduce((s, v) => s + v, 0) / list.length) : null);
const pct = (part, whole) => (whole > 0 ? r1((part / whole) * 100) : null);
const CHANNEL_LABEL = { whatsapp: 'WhatsApp', gmail: 'Email', panel: 'Typed in the panel', paste: 'Pasted' };

// How the office keeps up: tasks (made, finished, late) and draft orders
// (WhatsApp / email in, read by the AI, turned into orders), owner only.
async function operationsReport(user, query) {
  if (!isSuperAdmin(user)) throw new ApiError(403, 'Only the owner sees the operations report');
  const range = parseRange(query);
  const now = new Date();
  const AiUsage = require('mongoose').models.IntakeAiUsage;
  const [tasks, openTasks, drafts, usage, roles] = await Promise.all([
    Task.find({ $or: [{ createdAt: { $gte: range.start, $lte: range.end } }, { completedAt: { $gte: range.start, $lte: range.end } }] })
      .select('category status assignee assigneeName assigneeRole priority dueDate createdAt completedAt source')
      .lean(),
    Task.find({ status: { $in: TASK_OPEN_STATUSES } }).select('assigneeName assigneeRole dueDate status priority').lean(),
    Intake.find({ receivedAt: { $gte: range.start, $lte: range.end } }).select('channel status potentialOrder receivedAt readings history salesOrderNumber').lean(),
    AiUsage ? AiUsage.find({ at: { $gte: range.start, $lte: range.end } }).lean() : [],
    Role.find({}, 'slug name').lean(),
  ]);
  const roleName = new Map(roles.map((r) => [r.slug, r.name]));

  // ---- tasks
  const made = tasks.filter((t) => inRange(t.createdAt, range));
  const done = tasks.filter((t) => t.status === TASK_STATUSES.DONE && t.completedAt && inRange(t.completedAt, range));
  const late = (t) => t.dueDate && new Date(t.dueDate) < now;
  const finishDays = done.filter((t) => t.createdAt).map((t) => (new Date(t.completedAt) - new Date(t.createdAt)) / DAY);
  const onTimeDone = done.filter((t) => !t.dueDate || new Date(t.completedAt) <= new Date(t.dueDate)).length;
  const who = (t) => t.assigneeName || (t.assigneeRole ? `${roleName.get(t.assigneeRole) || t.assigneeRole} (team)` : 'Not assigned');
  const people = new Map();
  const bump = (key, field, n = 1) => {
    const p = people.get(key) || { who: key, open: 0, overdue: 0, done: 0, made: 0, days: [] };
    p[field] += n;
    people.set(key, p);
    return p;
  };
  for (const t of openTasks) {
    bump(who(t), 'open');
    if (late(t)) bump(who(t), 'overdue');
  }
  for (const t of made) bump(who(t), 'made');
  for (const t of done) {
    const p = bump(who(t), 'done');
    if (t.createdAt) p.days.push((new Date(t.completedAt) - new Date(t.createdAt)) / DAY);
  }
  const byCategory = new Map();
  for (const t of made) {
    const c = byCategory.get(t.category) || { category: t.category, made: 0, auto: 0, done: 0 };
    c.made += 1;
    if (t.source === 'auto') c.auto += 1;
    byCategory.set(t.category, c);
  }
  for (const t of done) {
    const c = byCategory.get(t.category) || { category: t.category, made: 0, auto: 0, done: 0 };
    c.done += 1;
    byCategory.set(t.category, c);
  }

  // ---- draft orders
  const monthly = new Map(monthsOf(range.from, range.to).map((m) => [m, { month: m, received: 0, orders: 0, converted: 0 }]));
  const byChannel = new Map();
  const reviewHours = [];
  let readOk = 0;
  let readFailed = 0;
  for (const d of drafts) {
    const converted = d.status === 'converted';
    const m = monthly.get(monthOf(d.receivedAt));
    if (m) {
      m.received += 1;
      if (d.potentialOrder) m.orders += 1;
      if (converted) m.converted += 1;
    }
    const c = byChannel.get(d.channel) || { channel: d.channel, label: CHANNEL_LABEL[d.channel] || d.channel, received: 0, orders: 0, converted: 0, discarded: 0 };
    c.received += 1;
    if (d.potentialOrder) c.orders += 1;
    if (converted) c.converted += 1;
    if (d.status === 'discarded') c.discarded += 1;
    byChannel.set(d.channel, c);
    const last = (d.readings || []).at(-1);
    if (last?.error) readFailed += 1;
    else if (last) readOk += 1;
    const conv = (d.history || []).find((h) => h.action === 'converted');
    if (conv?.at) reviewHours.push((new Date(conv.at) - new Date(d.receivedAt)) / 36e5);
  }
  const count = (status) => drafts.filter((d) => d.status === status).length;
  const aiDays = new Map();
  for (const u of usage) {
    const a = aiDays.get(u.day) || { day: u.day, calls: 0, failed: 0, inputTokens: 0, outputTokens: 0 };
    a.calls += 1;
    if (!u.ok) a.failed += 1;
    a.inputTokens += u.inputTokens || 0;
    a.outputTokens += u.outputTokens || 0;
    aiDays.set(u.day, a);
  }

  return {
    from: range.from,
    to: range.to,
    generatedAt: now,
    kpis: {
      tasksMade: made.length,
      tasksDone: done.length,
      tasksOpen: openTasks.length,
      tasksOverdue: openTasks.filter(late).length,
      avgDaysToFinish: avg(finishDays),
      doneOnTimePct: pct(onTimeDone, done.length),
      draftsReceived: drafts.length,
      draftsOrders: drafts.filter((d) => d.potentialOrder).length,
      draftsConverted: count('converted'),
      conversionPct: pct(count('converted'), drafts.filter((d) => d.potentialOrder).length),
      avgReviewHours: avg(reviewHours),
      waitingReview: count('needs_review') + count('customer_confirmed'),
      readOk,
      readFailed,
      aiCalls: usage.length,
      aiTokens: usage.reduce((s, u) => s + (u.inputTokens || 0) + (u.outputTokens || 0), 0),
    },
    people: [...people.values()].map((p) => ({ who: p.who, open: p.open, overdue: p.overdue, made: p.made, done: p.done, avgDays: avg(p.days) })).sort((a, b) => b.overdue - a.overdue || b.open - a.open),
    taskKinds: [...byCategory.values()].sort((a, b) => b.made - a.made),
    draftsByMonth: [...monthly.values()],
    draftsByChannel: [...byChannel.values()].sort((a, b) => b.received - a.received),
    draftOutcomes: [
      { status: 'converted', label: 'Turned into orders', count: count('converted') },
      { status: 'review', label: 'Waiting for review', count: count('needs_review') + count('customer_confirmed') },
      { status: 'failed', label: 'Reading failed', count: count('reading_failed') },
      { status: 'waiting', label: 'Waiting to be read', count: count('received') + count('reading') },
      { status: 'stored', label: 'Not an order', count: count('stored') },
      { status: 'discarded', label: 'Discarded', count: count('discarded') },
    ],
    aiByDay: [...aiDays.values()].sort((a, b) => b.day.localeCompare(a.day)),
  };
}

module.exports = { operationsReport };
