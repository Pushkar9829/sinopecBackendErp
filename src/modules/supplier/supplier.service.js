const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { nextSeq } = require('../../utils/counter');
const { toBool } = require('../../utils/permissions');
const Supplier = require('./supplier.model');

const TEXT_FIELDS = ['name', 'gstNumber', 'contactPerson', 'mobile', 'email', 'address', 'materials', 'notes'];
const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

function present(doc) {
  return doc ? doc.toJSON() : null;
}

function clean(payload, current = {}) {
  const data = {};
  for (const field of TEXT_FIELDS) {
    data[field] = payload[field] !== undefined ? String(payload[field] ?? '').trim() : current[field] || '';
  }
  if (!data.name) throw new ApiError(400, 'Supplier name is required');
  data.gstNumber = data.gstNumber.toUpperCase();
  if (data.gstNumber && !GSTIN.test(data.gstNumber)) throw new ApiError(400, 'GST number is not in the right format (15 characters)');
  if (payload.isActive !== undefined) data.isActive = toBool(payload.isActive);
  return data;
}

async function assertUniqueGst(gstNumber, exceptId) {
  if (!gstNumber) return;
  const clash = await Supplier.findOne({ gstNumber, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }).select('code name');
  if (clash) throw new ApiError(409, `${clash.name} (${clash.code}) already has this GST number`);
}

async function listSuppliers({ activeOnly = false } = {}) {
  const rows = await Supplier.find(activeOnly ? { isActive: true } : {}).sort({ name: 1 }).collation({ locale: 'en', strength: 2 });
  return rows.map(present);
}

async function loadSupplier(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Supplier not found');
  const doc = await Supplier.findById(id);
  if (!doc) throw new ApiError(404, 'Supplier not found');
  return doc;
}

async function getSupplier(id) {
  return present(await loadSupplier(id));
}

async function createSupplier(payload = {}, { checkFields = false } = {}) {
  const data = clean(payload);
  if (checkFields) await require('../formFields/formFields.service').assertComplete('supplier', data, 'This supplier');
  await assertUniqueGst(data.gstNumber);
  data.code = `SUP-${String(await nextSeq('supplier')).padStart(5, '0')}`;
  return present(await Supplier.create(data));
}

async function updateSupplier(id, payload = {}, { checkFields = false } = {}) {
  const doc = await loadSupplier(id);
  const data = clean(payload, doc.toObject());
  if (checkFields) await require('../formFields/formFields.service').assertComplete('supplier', data, 'This supplier');
  await assertUniqueGst(data.gstNumber, doc._id);
  doc.set(data);
  await doc.save();
  return present(doc);
}

// A supplier already on stock lots is kept for their history; deactivate it instead.
async function deleteSupplier(id) {
  const doc = await loadSupplier(id);
  const InventoryItem = require('../inventory/item.model');
  const used = await InventoryItem.countDocuments({ supplier: doc._id });
  if (used) throw new ApiError(400, `${doc.name} is on ${used} stock lot(s). Mark it inactive instead.`);
  await doc.deleteOne();
}

module.exports = { listSuppliers, getSupplier, loadSupplier, createSupplier, updateSupplier, deleteSupplier };
