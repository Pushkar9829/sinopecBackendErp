const SalesOrder = require('./salesOrder.model');

const populate = [
  { path: 'customer' },
  { path: 'createdBy', select: 'fullName username' },
  { path: 'cancelledBy', select: 'fullName username' },
  { path: 'attachments.uploadedBy', select: 'fullName username' },
];

function findAll(filter = {}) {
  return SalesOrder.find(filter).populate(populate).sort({ createdAt: -1 });
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
  findById,
  create,
  save,
  deleteById,
  countAll,
  countByStatus,
};
