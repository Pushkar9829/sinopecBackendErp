const RefreshToken = require('./refreshToken.model');
const RevokedAccessToken = require('./revokedAccessToken.model');

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

// Atomically marks a live token as used. Returns null when it was already
// used, revoked or expired, so two concurrent refreshes can't both win.
function claimByHash(tokenHash) {
  return RefreshToken.findOneAndUpdate(
    { tokenHash, revokedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { revokedAt: new Date() } },
    { new: true }
  );
}

function findByHash(tokenHash) {
  return RefreshToken.findOne({ tokenHash });
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

function revokeAccessJti(jti, expiresAt) {
  return RevokedAccessToken.updateOne({ jti }, { $setOnInsert: { jti, expiresAt } }, { upsert: true });
}

function isAccessJtiRevoked(jti) {
  return RevokedAccessToken.exists({ jti });
}

module.exports = {
  create,
  revokeAccessJti,
  isAccessJtiRevoked,
  findValidByHash,
  claimByHash,
  findByHash,
  revokeByHash,
  revokeAllForUser,
};
