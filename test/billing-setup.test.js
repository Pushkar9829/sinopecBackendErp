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

test('company details: everyone reads, only the Super Admin changes, bad GSTIN refused', async () => {
  const sales = await h.signIn('sales');
  const view = (await sales.get('/api/company-settings')).data.data;
  assert.equal(view.legalName, 'SINOPEC POLYMERS');
  assert.equal(view.defaultCreditDays, 30);
  assert.equal((await sales.put('/api/company-settings', { legalName: 'X' })).status, 403);
  assert.equal((await owner.put('/api/company-settings', { gstin: 'not-a-gstin' })).status, 400);
  const saved = await owner.put('/api/company-settings', { gstin: '07AAAAA1111A1Z5', defaultCreditDays: 45, bankIfsc: 'hdfc0001234' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.data.stateCode, '07');
  assert.equal(saved.data.data.bankIfsc, 'HDFC0001234');
  assert.equal(saved.data.data.defaultCreditDays, 45);
});

test('customers keep credit days and limit; blank days means the company default', async () => {
  const created = await owner.post('/api/customers', { name: 'Credit Test Co', creditDays: 60, creditLimit: 500000 });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.data.creditDays, 60);
  assert.equal(created.data.data.creditLimit, 500000);
  const id = created.data.data.id;
  assert.equal((await owner.patch(`/api/customers/${id}`, { creditDays: -1 })).status, 400);
  const cleared = await owner.patch(`/api/customers/${id}`, { creditDays: '' });
  assert.equal(cleared.data.data.creditDays, null);
  assert.equal(cleared.data.data.creditLimit, 500000, 'other fields kept');
});

test('a new order takes credit days from the customer, then the company default; typed days win', async () => {
  await owner.put('/api/company-settings', { defaultCreditDays: 45 });
  const own = (await owner.post('/api/customers', { name: 'Own Terms Ltd', creditDays: 15 })).data.data;
  const plain = (await owner.post('/api/customers', { name: 'Default Terms Ltd' })).data.data;
  const line = { product: 'Polly bag', quantity: 100, unit: 'pcs', rate: 2, taxPercent: 18, hsnCode: ' 3923 21 ', productionRoute: 'roll_cut_dispatch' };
  const a = await owner.post('/api/sales-orders', { customerId: own.id, items: [line] });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(a.data.data.creditDays, 15);
  assert.equal(a.data.data.items[0].hsnCode, '392321', 'HSN kept without spaces');
  const b = await owner.post('/api/sales-orders', { customerId: plain.id, items: [line] });
  assert.equal(b.data.data.creditDays, 45);
  const c = await owner.post('/api/sales-orders', { customerId: own.id, creditDays: 7, items: [line] });
  assert.equal(c.data.data.creditDays, 7);
});

test('suppliers: codes, GST checked and unique, used suppliers cannot be deleted', async () => {
  const a = await owner.post('/api/suppliers', { name: 'Manglam Packagings', gstNumber: '07abcde1234f1z5', materials: 'LDPE' });
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.equal(a.data.data.code, 'SUP-00001');
  assert.equal(a.data.data.gstNumber, '07ABCDE1234F1Z5');
  assert.equal((await owner.post('/api/suppliers', { name: 'Copy', gstNumber: '07ABCDE1234F1Z5' })).status, 409);
  assert.equal((await owner.post('/api/suppliers', { name: 'Bad GST', gstNumber: '123' })).status, 400);
  assert.equal((await owner.post('/api/suppliers', { name: '' })).status, 400);

  const lot = await owner.post('/api/inventory/items', { category: 'raw', name: 'LDPE lot S1', materialType: 'LDPE', unit: 'kg', quantity: 100, supplierId: a.data.data.id });
  assert.equal(lot.status, 201, JSON.stringify(lot.data));
  assert.equal(lot.data.data.supplierName, 'Manglam Packagings');
  assert.equal((await owner.del(`/api/suppliers/${a.data.data.id}`)).status, 400);
  const inactive = await owner.patch(`/api/suppliers/${a.data.data.id}`, { isActive: false });
  assert.equal(inactive.data.data.isActive, false);
  const active = (await owner.get('/api/suppliers?active=1')).data.data;
  assert.ok(!active.some((s) => s.id === a.data.data.id), 'inactive suppliers hidden from the picker');

  const production = await h.signIn('production');
  assert.equal((await production.get('/api/suppliers')).status, 200, 'production can read');
  assert.equal((await production.post('/api/suppliers', { name: 'Nope' })).status, 403, 'only store can add');
  assert.ok(await db.collection('suppliers').countDocuments() >= 1);
});

test('a supplier only sticks to raw material', async () => {
  const supplier = (await owner.post('/api/suppliers', { name: 'Panamax Ltd' })).data.data;
  const stage = await db.collection('inventorystages').findOne({});
  const output = await owner.post('/api/inventory/items', { category: 'output', name: 'Out lot', materialType: 'LDPE', unit: 'kg', quantity: 1, stageId: String(stage._id), supplierId: supplier.id });
  assert.equal(output.status, 201, JSON.stringify(output.data));
  assert.equal(output.data.data.supplierId, '');
});
