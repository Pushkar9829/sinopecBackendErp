const Intake = require('./intake.model');

function list() {
  return Intake.find().sort({ receivedAt: -1 }).limit(200);
}

function findById(id) {
  return Intake.findById(id);
}

function findByProvider(channel, providerMessageId) {
  return Intake.findOne({ channel, providerMessageId });
}

function claimNextReceived() {
  return Intake.findOneAndUpdate(
    { status: 'received' },
    { $set: { status: 'reading', error: '' } },
    { sort: { createdAt: 1 }, new: true }
  );
}

function claimById(id) {
  return Intake.findOneAndUpdate(
    { _id: id, status: 'received' },
    { $set: { status: 'reading', error: '' } },
    { new: true }
  );
}

module.exports = {
  Intake,
  list,
  findById,
  findByProvider,
  claimNextReceived,
  claimById,
};
