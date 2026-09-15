const Permission = require('./permission.model');

function findAll() {
  return Permission.find().sort({ module: 1, key: 1 });
}

function findById(id) {
  return Permission.findById(id);
}

function findByIds(ids) {
  return Permission.find({ _id: { $in: ids } });
}

function findByKeys(keys) {
  return Permission.find({ key: { $in: keys } });
}

function upsertByKey(data) {
  return Permission.findOneAndUpdate(
    { key: data.key },
    { $set: data },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

module.exports = {
  findAll,
  findById,
  findByIds,
  findByKeys,
  upsertByKey,
};
