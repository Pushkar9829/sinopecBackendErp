const RefreshToken = require('./refreshToken.model');

function create(data) {
  return RefreshToken.create(data);
}

function findValidByHash(tokenHash) {
  return RefreshToken.findOne({
    tokenHash,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
}

function revokeByHash(tokenHash) {
  return RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null },
    { $set: { revokedAt: new Date() } },
    { new: true }
  );
}

function revokeAllForUser(userId) {
  return RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

module.exports = {
  create,
  findValidByHash,
  revokeByHash,
  revokeAllForUser,
};
