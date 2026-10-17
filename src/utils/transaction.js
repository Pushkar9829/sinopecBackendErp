const { AsyncLocalStorage } = require('async_hooks');
const mongoose = require('mongoose');

// Multi-step stock work (take from a lot, save the order, create output lots)
// runs in one MongoDB transaction: either every write lands or none does.
// Mongoose's transactionAsyncLocalStorage (enabled in config/db.js) makes every
// query inside inTransaction() join the transaction without passing sessions.
//
// Transactions need a replica set (Atlas always is). On a standalone local
// mongod the work runs as before, protected by version checks and undo steps.

let supported = null;

async function transactionsSupported() {
  if (supported !== null) return supported;
  try {
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    supported = Boolean(hello.setName || hello.msg === 'isdbgrid');
  } catch {
    supported = false;
  }
  if (!supported) console.warn('MongoDB is not a replica set: floor actions run without transactions.');
  return supported;
}

// Follow-up work (task sync, register marks) must not share the transaction:
// a failure there should never undo real stock work, and some of it expects
// duplicate-key errors, which would abort a transaction. It is queued and run
// once the transaction has committed.
const followUps = new AsyncLocalStorage();

async function inTransaction(work) {
  const queue = [];
  const attempt = () => {
    queue.length = 0; // a retried attempt starts with a clean queue
    return followUps.run(queue, work);
  };
  const result = (await transactionsSupported()) ? await mongoose.connection.transaction(attempt) : await attempt();
  for (const step of queue) {
    try {
      await step();
    } catch (error) {
      console.error('Follow-up after a floor action failed (it is repaired by the next sync)', error.message);
    }
  }
  return result;
}

// Runs `step` after the surrounding transaction commits, or right away when
// there is none.
function afterCommit(step) {
  const queue = followUps.getStore();
  if (queue) {
    queue.push(step);
    return Promise.resolve();
  }
  return step();
}

module.exports = { inTransaction, afterCommit, transactionsSupported };
