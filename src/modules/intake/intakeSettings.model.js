const mongoose = require('mongoose');

// Secret fields (keys, tokens) are stored encrypted; see utils/secretBox.
const intakeSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'default' },
    publicBaseUrl: { type: String, default: '', trim: true },

    whatsappVerifyToken: { type: String, default: '' },
    whatsappAppSecret: { type: String, default: '' },
    whatsappAccessToken: { type: String, default: '' },
    whatsappPhoneNumberId: { type: String, default: '', trim: true },
    // Messages from one number within this many minutes are one draft.
    whatsappWindowMinutes: { type: Number, default: 30 },

    gmailClientId: { type: String, default: '', trim: true },
    gmailClientSecret: { type: String, default: '' },
    gmailRefreshToken: { type: String, default: '' },
    gmailEmail: { type: String, default: '', trim: true },
    gmailHistoryId: { type: String, default: '' },
    gmailLastSyncAt: { type: Date, default: null },
    gmailLastError: { type: String, default: '' },

    orderKeywords: { type: String, default: '' },

    // AI reader: gemini | claude | openai (any OpenAI-compatible server, e.g. Ollama / vLLM).
    aiProvider: { type: String, enum: ['gemini', 'claude', 'openai'], default: 'gemini' },
    aiFallbackProvider: { type: String, enum: ['', 'gemini', 'claude', 'openai'], default: '' },
    geminiApiKey: { type: String, default: '' },
    geminiModel: { type: String, default: 'gemini-3.5-flash-lite', trim: true },
    claudeApiKey: { type: String, default: '' },
    claudeModel: { type: String, default: 'claude-opus-5-5', trim: true },
    openaiBaseUrl: { type: String, default: '', trim: true },
    openaiApiKey: { type: String, default: '' },
    openaiModel: { type: String, default: '', trim: true },
    dailyReadLimit: { type: Number, default: 200 },

    // Automatic "we received your order" replies. Off until switched on.
    autoReplyEnabled: { type: Boolean, default: false },
    // Test mode: only the numbers / addresses below get a reply.
    autoReplyTestMode: { type: Boolean, default: true },
    autoReplyTestRecipients: { type: String, default: '' },
    autoReplyText: {
      type: String,
      default: 'Thank you, we have received your order request ({number}). Our team will check it and confirm shortly.',
    },
    autoReplyDailyPerSender: { type: Number, default: 3 },

    retentionDays: { type: Number, default: 30 },
    reviewSlaHours: { type: Number, default: 4 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('IntakeSettings', intakeSettingsSchema);
