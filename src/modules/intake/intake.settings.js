const IntakeSettings = require('./intakeSettings.model');
const { parseKeywords } = require('./intake.keywords');

const SECRET_FIELDS = ['whatsappAppSecret', 'whatsappAccessToken', 'gmailClientSecret', 'gmailRefreshToken', 'geminiApiKey'];

async function getSettings() {
  let doc = await IntakeSettings.findOne({ key: 'default' });
  if (!doc) {
    doc = await IntakeSettings.create({ key: 'default', geminiModel: 'gemini-3.5-flash-lite' });
  }
  return doc;
}

function presentSettings(doc) {
  const base = String(doc.publicBaseUrl || '').replace(/\/$/, '');
  return {
    publicBaseUrl: doc.publicBaseUrl || '',
    webhookUrl: base ? `${base}/api/intake/whatsapp` : '',
    gmailRedirectUrl: base ? `${base}/api/intake/gmail/callback` : '',
    whatsappVerifyToken: doc.whatsappVerifyToken || '',
    whatsappPhoneNumberId: doc.whatsappPhoneNumberId || '',
    gmailClientId: doc.gmailClientId || '',
    gmailEmail: doc.gmailEmail || '',
    geminiModel: doc.geminiModel || 'gemini-3.5-flash-lite',
    orderKeywords: parseKeywords(doc.orderKeywords).join('\n'),
    whatsappAppSecretSet: Boolean(doc.whatsappAppSecret),
    whatsappAccessTokenSet: Boolean(doc.whatsappAccessToken),
    gmailClientSecretSet: Boolean(doc.gmailClientSecret),
    gmailConnected: Boolean(doc.gmailRefreshToken),
    geminiApiKeySet: Boolean(doc.geminiApiKey),
  };
}

function keepSecret(next, previous) {
  if (next === undefined || next === null || String(next).trim() === '') return previous || '';
  return String(next).trim();
}

async function saveSettings(payload) {
  const doc = await getSettings();
  const text = (key) => (payload[key] === undefined ? doc[key] : String(payload[key] || '').trim());
  doc.publicBaseUrl = text('publicBaseUrl');
  doc.whatsappVerifyToken = text('whatsappVerifyToken');
  doc.whatsappPhoneNumberId = text('whatsappPhoneNumberId');
  doc.gmailClientId = text('gmailClientId');
  doc.geminiModel = text('geminiModel') || 'gemini-3.5-flash-lite';
  doc.orderKeywords = parseKeywords(text('orderKeywords')).join('\n');
  for (const field of SECRET_FIELDS) {
    if (field === 'gmailRefreshToken') continue;
    doc[field] = keepSecret(payload[field], doc[field]);
  }
  await doc.save();
  return doc;
}

module.exports = {
  getSettings,
  presentSettings,
  saveSettings,
};
