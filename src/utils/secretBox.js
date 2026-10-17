const crypto = require('crypto');
const env = require('../config/env');

// Encrypts settings secrets (API keys, tokens) before they are stored.
// Key: INTAKE_SECRET_KEY (any long random string) or, when that is not set,
// one derived from JWT_ACCESS_SECRET. Changing the key makes stored secrets
// unreadable, so they have to be entered again.
const PREFIX = 'enc:v1:';

let cachedKey = null;
function key() {
  if (cachedKey) return cachedKey;
  const material = process.env.INTAKE_SECRET_KEY || env.jwtAccessSecret;
  cachedKey = Buffer.from(crypto.hkdfSync('sha256', material, 'sinopec-settings', 'secret-box-v1', 32));
  return cachedKey;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function seal(plain) {
  const text = String(plain || '');
  if (!text) return '';
  if (isEncrypted(text)) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

// Values saved before encryption existed are plain text and read as they are.
function open(stored) {
  const text = String(stored || '');
  if (!isEncrypted(text)) return text;
  try {
    const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

module.exports = { seal, open, isEncrypted };
