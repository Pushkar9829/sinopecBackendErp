const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);

async function nextSeq(key) {
  const doc = await Counter.findOneAndUpdate({ key }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return doc.seq;
}

function pad(value, size = 5) {
  return String(value).padStart(size, '0');
}

async function nextCustomerCode() {
  const seq = await nextSeq('customer');
  return `CUST-${pad(seq)}`;
}

async function nextSalesOrderNumber(date = new Date()) {
  const year = date.getFullYear();
  const seq = await nextSeq(`salesOrder:${year}`);
  return `SO-${year}-${pad(seq)}`;
}

module.exports = {
  nextSeq,
  nextCustomerCode,
  nextSalesOrderNumber,
};
