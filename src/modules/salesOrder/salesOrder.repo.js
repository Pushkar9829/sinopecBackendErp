const SalesOrder = require('./salesOrder.model');

const populate = [
  // Everything else comes from customerSnapshot. The full customer document
  // carries every saved product with its images, which made lists huge.
  { path: 'customer', select: 'name code' },
  { path: 'createdBy', select: 'fullName username' },
  { path: 'cancelledBy', select: 'fullName username' },
  { path: 'attachments.uploadedBy', select: 'fullName username' },
];

function findAll(filter = {}) {
  return SalesOrder.find(filter).populate(populate).sort({ createdAt: -1 });
}

// For screens that walk many orders (registers, floor queue, task sync):
// leaves out photos, attachments and the payments list, which they never use.
const FLOOR_EXCLUDE = '-attachments -payments -items.image -items.images';

// { lean: true } returns plain objects: read-only screens skip building full
// Mongoose documents, which was most of their time (~0.5 s per 300 orders).
// Never save or modify what a lean read returns.
function findAllForFloor(filter = {}, { lean = false } = {}) {
  const query = SalesOrder.find(filter).select(FLOOR_EXCLUDE).populate(populate).sort({ createdAt: -1 });
  return lean ? query.lean() : query;
}

function findById(id) {
  return SalesOrder.findById(id).populate(populate);
}

function create(data) {
  return SalesOrder.create(data);
}

function save(doc) {
  return doc.save();
}

function deleteById(id) {
  return SalesOrder.deleteOne({ _id: id });
}

function countAll() {
  return SalesOrder.countDocuments();
}

function countByStatus() {
  return SalesOrder.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]);
}

module.exports = {
  findAll,
  findAllForFloor,
  findById,
  create,
  save,
  deleteById,
  countAll,
  countByStatus,
};
