const ApiError = require('../../utils/ApiError');
const { checkBaseUrl } = require('./ai/openaiCompatible');
const IntakeSettings = require('./intakeSettings.model');
const { parseKeywords } = require('./intake.keywords');
const { seal, open, isEncrypted } = require('../../utils/secretBox');

const SECRET_FIELDS = [
  'whatsappAppSecret',
  'whatsappAccessToken',
  'gmailClientSecret',
  'gmailRefreshToken',
  'geminiApiKey',
  'claudeApiKey',
  'openaiApiKey',
];
// Typed by a person on the setup screen (the Gmail refresh token comes from Google).
const TYPED_SECRETS = SECRET_FIELDS.filter((field) => field !== 'gmailRefreshToken');
const PROVIDERS = ['gemini', 'claude', 'openai'];

const TEXT_FIELDS = [
  'publicBaseUrl',
  'whatsappVerifyToken',
  'whatsappPhoneNumberId',
  'gmailClientId',
  'geminiModel',
  'claudeModel',
  'openaiBaseUrl',
  'openaiModel',
  'autoReplyTestRecipients',
  'autoReplyText',
];

const NUMBER_FIELDS = {
  whatsappWindowMinutes: [5, 24 * 60],
  dailyReadLimit: [0, 100000],
  autoReplyDailyPerSender: [0, 50],
  retentionDays: [7, 3650],
  reviewSlaHours: [1, 24 * 14],
};

async function loadDoc() {
  let doc = await IntakeSettings.findOne({ key: 'default' });
  if (!doc) {
    try {
      doc = await IntakeSettings.create({ key: 'default' });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      doc = await IntakeSettings.findOne({ key: 'default' });
    }
  }
  // Secrets saved before encryption existed are encrypted on first read.
  const plain = SECRET_FIELDS.filter((field) => doc[field] && !isEncrypted(doc[field]));
  if (plain.length) {
    for (const field of plain) doc[field] = seal(doc[field]);
    await doc.save();
  }
  return doc;
}

// Plain object with secrets readable. Never sent to the browser.
async function getSettings() {
  const doc = await loadDoc();
  const settings = doc.toObject();
  for (const field of SECRET_FIELDS) settings[field] = open(doc[field]);
  return settings;
}

async function updateSettingsFields(fields) {
  const doc = await loadDoc();
  for (const [field, value] of Object.entries(fields)) {
    doc[field] = SECRET_FIELDS.includes(field) ? seal(value) : value;
  }
  await doc.save();
  return doc;
}

function webhookBase(settings) {
  return String(settings.publicBaseUrl || '').replace(/\/$/, '');
}

function presentSettings(settings) {
  const base = webhookBase(settings);
  const view = {
    webhookUrl: base ? `${base}/api/intake/whatsapp` : '',
    gmailRedirectUrl: base ? `${base}/api/intake/gmail/callback` : '',
    orderKeywords: parseKeywords(settings.orderKeywords).join('\n'),
    gmailEmail: settings.gmailEmail || '',
    gmailConnected: Boolean(settings.gmailRefreshToken),
    gmailLastSyncAt: settings.gmailLastSyncAt || null,
    gmailLastError: settings.gmailLastError || '',
    aiProvider: settings.aiProvider || 'gemini',
    aiFallbackProvider: settings.aiFallbackProvider || '',
    autoReplyEnabled: Boolean(settings.autoReplyEnabled),
    autoReplyTestMode: settings.autoReplyTestMode !== false,
  };
  for (const field of TEXT_FIELDS) view[field] = settings[field] || '';
  for (const field of Object.keys(NUMBER_FIELDS)) view[field] = settings[field];
  for (const field of TYPED_SECRETS) view[`${field}Set`] = Boolean(settings[field]);
  return view;
}

function clampNumber(value, [min, max], fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

async function saveSettings(payload) {
  const doc = await loadDoc();
  const previousOpenaiBase = String(doc.openaiBaseUrl || '').trim();
  if (payload.openaiBaseUrl !== undefined) {
    const problem = checkBaseUrl(payload.openaiBaseUrl);
    if (problem) throw new ApiError(400, problem);
  }
  for (const field of TEXT_FIELDS) {
    if (payload[field] !== undefined) doc[field] = String(payload[field] || '').trim();
  }
  if (!doc.geminiModel) doc.geminiModel = 'gemini-3.5-flash-lite';
  if (!doc.claudeModel) doc.claudeModel = 'claude-opus-5-5';
  if (!doc.autoReplyText) doc.autoReplyText = IntakeSettings.schema.path('autoReplyText').defaultValue;
  if (payload.orderKeywords !== undefined) doc.orderKeywords = parseKeywords(payload.orderKeywords).join('\n');
  for (const [field, range] of Object.entries(NUMBER_FIELDS)) {
    if (payload[field] !== undefined) doc[field] = clampNumber(payload[field], range, doc[field]);
  }
  if (payload.aiProvider !== undefined && PROVIDERS.includes(payload.aiProvider)) doc.aiProvider = payload.aiProvider;
  if (payload.aiFallbackProvider !== undefined) {
    doc.aiFallbackProvider = PROVIDERS.includes(payload.aiFallbackProvider) ? payload.aiFallbackProvider : '';
  }
  if (doc.aiFallbackProvider === doc.aiProvider) doc.aiFallbackProvider = '';
  for (const field of ['autoReplyEnabled', 'autoReplyTestMode']) {
    if (payload[field] !== undefined) doc[field] = payload[field] === true || payload[field] === 'true';
  }
  // A blank secret keeps the saved one; `clear<Field>` removes it.
  for (const field of TYPED_SECRETS) {
    const clearFlag = `clear${field[0].toUpperCase()}${field.slice(1)}`;
    if (payload[clearFlag] === true) doc[field] = '';
    else if (payload[field] !== undefined && String(payload[field]).trim()) doc[field] = seal(String(payload[field]).trim());
  }
  // The saved key is sent to the server address: a new address without a new
  // key in the same save drops the old key, so it can't be redirected to
  // someone else's server.
  const newOpenaiKey = payload.openaiApiKey !== undefined && String(payload.openaiApiKey).trim();
  if (String(doc.openaiBaseUrl || '').trim() !== previousOpenaiBase && !newOpenaiKey) doc.openaiApiKey = '';
  await doc.save();
  return getSettings();
}

module.exports = {
  SECRET_FIELDS,
  getSettings,
  updateSettingsFields,
  presentSettings,
  saveSettings,
};
