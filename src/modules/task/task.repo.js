const Task = require('./task.model');

// Dated tasks first (soonest due on top), then undated ones; MongoDB alone would sort nulls first.
async function find(filter, { limit = 500 } = {}) {
  const dated = await Task.find({ $and: [filter, { dueDate: { $ne: null } }] })
    .sort({ dueDate: 1, createdAt: -1 })
    .limit(limit);
  if (dated.length >= limit) return dated;
  const undated = await Task.find({ $and: [filter, { dueDate: null }] })
    .sort({ createdAt: -1 })
    .limit(limit - dated.length);
  return dated.concat(undated);
}

// One page in the same order as find(): dated tasks (soonest first), then
// undated ones (newest first).
async function findPage(filter, { page = 1, pageSize = 25 } = {}) {
  const datedFilter = { $and: [filter, { dueDate: { $ne: null } }] };
  const undatedFilter = { $and: [filter, { dueDate: null }] };
  const [datedCount, undatedCount] = await Promise.all([Task.countDocuments(datedFilter), Task.countDocuments(undatedFilter)]);
  const start = (page - 1) * pageSize;
  let items = [];
  if (start < datedCount) {
    items = await Task.find(datedFilter).sort({ dueDate: 1, createdAt: -1 }).skip(start).limit(pageSize);
  }
  if (items.length < pageSize) {
    const undatedStart = Math.max(0, start - datedCount);
    const more = await Task.find(undatedFilter)
      .sort({ createdAt: -1 })
      .skip(undatedStart)
      .limit(pageSize - items.length);
    items = items.concat(more);
  }
  return { items, total: datedCount + undatedCount };
}

function findById(id) {
  return Task.findById(id);
}

function findByOrder(orderId) {
  return Task.find({ order: orderId }).sort({ createdAt: 1 });
}

function findOne(filter) {
  return Task.findOne(filter);
}

function exists(filter) {
  return Task.exists(filter);
}

function create(data) {
  return Task.create(data);
}

function save(doc) {
  return doc.save();
}

function count(filter) {
  return Task.countDocuments(filter);
}

function deleteByOrder(orderId) {
  return Task.deleteMany({ order: orderId });
}

function releaseAssignee(userId, roleSlug) {
  return Task.updateMany({ assignee: userId, status: { $in: ['open', 'in_progress', 'blocked'] } }, [
    {
      $set: {
        assignee: null,
        assigneeName: '',
        assigneeRole: { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ['$assigneeRole', ''] } }, 0] }, '$assigneeRole', roleSlug || ''] },
        status: { $cond: [{ $eq: ['$status', 'in_progress'] }, 'open', '$status'] },
      },
    },
  ]);
}

module.exports = {
  findPage,
  find,
  findById,
  findByOrder,
  findOne,
  exists,
  create,
  save,
  count,
  deleteByOrder,
  releaseAssignee,
};
