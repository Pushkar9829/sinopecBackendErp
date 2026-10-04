const mongoose = require('mongoose');

const intakeSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'default' },
    publicBaseUrl: { type: String, default: '', trim: true },
    whatsappVerifyToken: { type: String, default: '' },
    whatsappAppSecret: { type: String, default: '' },
    whatsappAccessToken: { type: String, default: '' },
    whatsappPhoneNumberId: { type: String, default: '', trim: true },
    gmailClientId: { type: String, default: '', trim: true },
    gmailClientSecret: { type: String, default: '' },
    gmailRefreshToken: { type: String, default: '' },
    gmailEmail: { type: String, default: '', trim: true },
    geminiApiKey: { type: String, default: '' },
    geminiModel: { type: String, default: 'gemini-3.5-flash-lite', trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('IntakeSettings', intakeSettingsSchema);
