const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

let db;
let supported = false;
before(async () => {
  ({ db } = await h.startApp());
  supported = await require('../src/utils/transaction').transactionsSupported();
});
after(h.stopApp);

test('a floor action that fails halfway leaves stock, order and lots untouched', async (t) => {
  if (!supported) return t.skip('MongoDB is not a replica set (start mongod with --replSet to run this)');
  const { inTransaction, afterCommit } = require('../src/utils/transaction');
  const itemRepo = require('../src/modules/inventory/item.repo');
  const Item = require('../src/modules/inventory/item.model');
  const SalesOrder = require('../src/modules/salesOrder/salesOrder.model');

  const lot = await Item.findOne({ category: 'raw', quantity: { $gt: 10 } });
  const order = await SalesOrder.findOne({ status: 'in_production' });
  const before = { stock: lot.quantity, remarks: order.remarks, lots: await Item.countDocuments() };
  let followUpRan = false;

  await assert.rejects(
    inTransaction(async () => {
      await itemRepo.takeQuantity(lot._id, 5);
      order.remarks = 'changed inside the transaction';
      await order.save();
      await Item.create({ category: 'waste', name: 'transaction test', materialType: 'x', unit: 'kg', quantity: 1 });
      afterCommit(async () => {
        followUpRan = true;
      });
      throw new Error('simulated crash halfway');
    }),
    /simulated crash/
  );

  assert.equal((await Item.findById(lot._id)).quantity, before.stock);
  assert.equal((await SalesOrder.findById(order._id)).remarks, before.remarks);
  assert.equal(await Item.countDocuments(), before.lots);
  assert.equal(followUpRan, false, 'follow-ups only run after a commit');

  let ran = false;
  await inTransaction(async () => {
    await itemRepo.takeQuantity(lot._id, 1);
    afterCommit(async () => {
      ran = true;
    });
  });
  assert.equal((await Item.findById(lot._id)).quantity, before.stock - 1);
  assert.equal(ran, true);
});

test('register entries keep their id when the register is rebuilt', async () => {
  const owner = await h.signIn('owner', h.OWNER_PASSWORD);
  const book = (await owner.get('/api/registers/stage/rolling')).data.data;
  const entry = book.entries[0];
  assert.ok(entry, 'seeded rolling entry');
  const register = await db.collection('registers').findOne({ 'entries._id': h.asId(entry.id) });
  // Drop the register entirely; the next read rebuilds it from the order.
  await db.collection('registers').deleteOne({ _id: register._id });
  const rebuilt = (await owner.get('/api/registers/stage/rolling')).data.data;
  assert.ok(rebuilt.entries.some((e) => e.id === entry.id), `entry ${entry.id} kept its id after the rebuild`);
});
