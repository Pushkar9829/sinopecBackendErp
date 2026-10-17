const mongoose = require('mongoose');

// A small job queue kept in MongoDB, so background work (reading mail,
// downloading WhatsApp files, AI reading, replies) survives restarts, retries
// with backoff, and never runs twice at once across server instances.
const jobSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    status: { type: String, enum: ['pending', 'running', 'done', 'failed'], default: 'pending' },
    runAt: { type: Date, default: Date.now },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lastError: { type: String, default: '' },
    lockedUntil: { type: Date, default: null },
    // Set only while pending/running: the same key can't be queued twice.
    activeKey: { type: String },
    // Another enqueue arrived while this ran: run once more when it finishes.
    rerun: { type: Boolean, default: false },
    // Recurring jobs go back to pending after each run instead of finishing.
    everyMs: { type: Number, default: 0 },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ activeKey: 1 }, { unique: true, sparse: true });
// Finished jobs are kept a week for troubleshooting, then removed.
jobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 });

const Job = mongoose.models.Job || mongoose.model('Job', jobSchema);

const LOCK_MS = 5 * 60 * 1000;
const handlers = new Map();
let timer = null;
let ticking = false;
let stopped = true;

class JobDeferred extends Error {
  constructor(runAt, message = 'Deferred') {
    super(message);
    this.runAt = runAt;
  }
}

function register(type, handler, { concurrency = 1 } = {}) {
  handlers.set(type, { handler, concurrency, running: 0 });
}

async function enqueue(type, payload = {}, { key, runAt, maxAttempts = 5, everyMs = 0 } = {}) {
  const doc = { type, payload, runAt: runAt || new Date(), maxAttempts, everyMs };
  if (!key) return Job.create(doc);
  try {
    return await Job.create({ ...doc, activeKey: key });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    // Already queued: a pending job will see the latest data; a running one
    // is asked to run once more so nothing that arrived meanwhile is missed.
    const updated = await Job.findOneAndUpdate(
      { activeKey: key, status: 'running', everyMs: 0 },
      { $set: { rerun: true, payload } },
      { new: true }
    );
    if (updated) return updated;
    if (everyMs) return Job.findOne({ activeKey: key });
    return Job.findOneAndUpdate({ activeKey: key }, { $set: { payload } }, { new: true });
  }
}

function ensureRecurring(type, everyMs, payload = {}) {
  return enqueue(type, payload, { key: `recurring:${type}`, everyMs, maxAttempts: 1000000 });
}

async function claim(type) {
  const now = new Date();
  return Job.findOneAndUpdate(
    {
      type,
      $or: [
        { status: 'pending', runAt: { $lte: now } },
        { status: 'running', lockedUntil: { $lt: now } },
      ],
    },
    { $set: { status: 'running', lockedUntil: new Date(Date.now() + LOCK_MS) }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true }
  );
}

function backoffMs(attempts) {
  return Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attempts - 1));
}

async function finish(job, error) {
  const base = { lockedUntil: null };
  if (error instanceof JobDeferred) {
    await Job.updateOne(
      { _id: job._id },
      { $set: { ...base, status: 'pending', runAt: error.runAt, lastError: error.message }, $inc: { attempts: -1 } }
    );
    return;
  }
  if (job.everyMs) {
    await Job.updateOne(
      { _id: job._id },
      {
        $set: { ...base, status: 'pending', attempts: 0, runAt: new Date(Date.now() + job.everyMs), lastError: error ? String(error.message || error) : '' },
      }
    );
    return;
  }
  if (!error) {
    const fresh = await Job.findById(job._id).select('rerun');
    if (fresh?.rerun) {
      await Job.updateOne({ _id: job._id }, { $set: { ...base, status: 'pending', rerun: false, attempts: 0, runAt: new Date() } });
      return;
    }
    await Job.updateOne({ _id: job._id }, { $set: { ...base, status: 'done', finishedAt: new Date() }, $unset: { activeKey: 1 } });
    return;
  }
  const message = String(error.message || error).slice(0, 1000);
  if (job.attempts < job.maxAttempts && !error.permanent) {
    await Job.updateOne(
      { _id: job._id },
      { $set: { ...base, status: 'pending', runAt: new Date(Date.now() + backoffMs(job.attempts)), lastError: message } }
    );
    return;
  }
  await Job.updateOne(
    { _id: job._id },
    { $set: { ...base, status: 'failed', lastError: message, finishedAt: new Date() }, $unset: { activeKey: 1 } }
  );
}

async function runJob(entry, job) {
  entry.running += 1;
  try {
    await entry.handler(job.payload || {}, job);
    await finish(job, null);
  } catch (error) {
    if (!(error instanceof JobDeferred)) console.error(`Job ${job.type} failed:`, error.message);
    await finish(job, error).catch((e) => console.error('Job bookkeeping failed:', e.message));
  } finally {
    entry.running -= 1;
  }
}

// One pass: claims what is due for every registered type, up to each type's
// concurrency. `wait` makes it resolve only when the claimed jobs finished.
async function tick({ wait = false } = {}) {
  const started = [];
  for (const [type, entry] of handlers) {
    while (entry.running < entry.concurrency) {
      const job = await claim(type);
      if (!job) break;
      started.push(runJob(entry, job));
    }
  }
  if (wait) await Promise.all(started);
  return started.length;
}

// Tests and scripts: keep running until nothing more is due.
async function drain(maxRounds = 50) {
  let total = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const ran = await tick({ wait: true });
    total += ran;
    if (!ran) break;
  }
  return total;
}

function start(pollMs = 2000) {
  if (timer) return;
  stopped = false;
  timer = setInterval(async () => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await tick();
    } catch (error) {
      console.error('Job queue tick failed:', error.message);
    } finally {
      ticking = false;
    }
  }, pollMs);
  timer.unref?.();
}

function stop() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { Job, JobDeferred, register, enqueue, ensureRecurring, tick, drain, start, stop };
