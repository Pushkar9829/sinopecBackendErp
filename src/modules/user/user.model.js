const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    passwordHash: { type: String, required: true },
    fullName: { type: String, required: true, trim: true },
    role: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', required: true },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
    // Bumped on password change and sign-out-everywhere: access tokens carry
    // the version they were issued with and older ones stop working at once.
    tokenVersion: { type: Number, default: 0 },
  },
  { timestamps: true }
);

userSchema.set('toJSON', {
  transform(doc, ret) {
    delete ret.passwordHash;
    ret.id = String(ret._id);
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
