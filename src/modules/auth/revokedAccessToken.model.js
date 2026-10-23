const mongoose = require('mongoose');

// Access tokens ended early by sign-out. Kept only until the token would have
// expired anyway.
const revokedAccessTokenSchema = new mongoose.Schema({
  jti: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
});

revokedAccessTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RevokedAccessToken', revokedAccessTokenSchema);
