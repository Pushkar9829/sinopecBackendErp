const crypto = require('crypto');
const { uploadBuffer } = require('../../utils/storage');
const jobs = require('../../utils/jobQueue');
const Intake = require('./intake.model');
const { getSettings } = require('./intake.settings');
const { parseKeywords, findKeywords } = require('./intake.keywords');

const GRAPH = () => (process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
const MAX_MEDIA_BYTES = 15 * 1024 * 1024;
// WhatsApp only allows a free-form reply within 24 hours of the customer's last message.
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

function signaturesMatch(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(String(header));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function verifyWebhook(req) {
  const settings = await getSettings();
  return signaturesMatch(req.rawBody, req.get('x-hub-signature-256'), settings.whatsappAppSecret);
}

async function verifySubscription(query) {
  const settings = await getSettings();
  const token = String(query['hub.verify_token'] || '');
  const expected = String(settings.whatsappVerifyToken || '');
  if (query['hub.mode'] !== 'subscribe' || !token || !expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Webhook: answer Meta at once; downloading and reading happen in jobs.
async function acceptPayload(payload) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  let queued = 0;
  for (const entry of entries) {
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      const value = change.value || {};
      const name = value.contacts?.[0]?.profile?.name || '';
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        if (!message?.id) continue;
        await jobs.enqueue('whatsapp:message', { message, contactName: name }, { key: `whatsapp:message:${message.id}`, maxAttempts: 6 });
        queued += 1;
      }
    }
  }
  return queued;
}

const EXT_BY_TYPE = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
};

async function downloadMedia(media, token) {
  const meta = await fetch(`${GRAPH()}/${encodeURIComponent(media.id)}`, { headers: { Authorization: `Bearer ${token}` } });
  const info = await meta.json().catch(() => ({}));
  if (!meta.ok || !info.url) throw new Error(info?.error?.message || 'WhatsApp media lookup failed');
  if (Number(info.file_size) > MAX_MEDIA_BYTES) throw Object.assign(new Error('The file is too large to keep'), { permanent: true });
  const file = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!file.ok) throw new Error('WhatsApp media download failed');
  const buffer = Buffer.from(await file.arrayBuffer());
  if (buffer.length > MAX_MEDIA_BYTES) throw Object.assign(new Error('The file is too large to keep'), { permanent: true });
  const mimeType = String(info.mime_type || file.headers.get('content-type') || '').split(';')[0].trim();
  const ext = EXT_BY_TYPE[mimeType] || '';
  const name = media.filename && /\.[a-z0-9]{2,5}$/i.test(media.filename) ? media.filename : `${media.id}${ext}`;
  return uploadBuffer({ buffer, originalName: name, mimeType, folder: 'intake' });
}

function messageText(message) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'image') return message.image?.caption || '';
  if (message.type === 'document') return message.document?.caption || '';
  if (message.type === 'video') return message.video?.caption || '';
  if (message.type === 'button') return message.button?.text || '';
  if (message.type === 'interactive') {
    return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
  }
  return '';
}

// Job: stores one WhatsApp message in the sender's current draft.
async function ingestMessage({ message, contactName }) {
  const service = require('./intake.service');
  if (await Intake.exists({ channel: 'whatsapp', messageIds: message.id })) return;
  const settings = await getSettings();
  const files = [];
  const warnings = [];
  const media = message.image || message.document || message.audio || null;
  if (media?.id) {
    if (!settings.whatsappAccessToken) warnings.push('WhatsApp access token is not set, so the file was not downloaded.');
    else {
      try {
        files.push(await downloadMedia(media, settings.whatsappAccessToken));
      } catch (error) {
        if (!error.permanent) throw error; // retried by the job queue
        warnings.push(`${media.filename || 'A file'}: ${error.message}`);
      }
    }
  }
  const body = [messageText(message), ...warnings.map((w) => `[${w}]`)].filter(Boolean).join('\n');
  const searchable = [body, message.document?.filename || ''].join('\n');
  const matched = findKeywords(searchable, parseKeywords(settings.orderKeywords));
  const captionless = (message.type === 'document' || message.type === 'image') && files.length > 0 && !messageText(message).trim();
  const { doc, duplicate } = await service.ingestMessage({
    channel: 'whatsapp',
    conversationKey: String(message.from || ''),
    windowMs: (settings.whatsappWindowMinutes || 30) * 60 * 1000,
    message: {
      providerMessageId: message.id,
      from: message.from || '',
      fromName: contactName || '',
      body,
      receivedAt: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date(),
    },
    files,
    sender: { phone: message.from || '', name: contactName || '' },
    matchedKeywords: matched,
    potentialOrder: matched.length > 0 || captionless,
  });
  if (!duplicate) await service.scheduleRead(doc);
}

async function sendText(intake, to, text) {
  const settings = await getSettings();
  if (!settings.whatsappAccessToken || !settings.whatsappPhoneNumberId) throw new Error('WhatsApp sending is not set up');
  if (Date.now() - new Date(intake.lastMessageAt).getTime() > REPLY_WINDOW_MS) {
    throw Object.assign(new Error('More than 24 hours since the customer wrote; WhatsApp needs a template message'), { skip: true });
  }
  const response = await fetch(`${GRAPH()}/${encodeURIComponent(settings.whatsappPhoneNumberId)}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.whatsappAccessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `WhatsApp returned ${response.status}`);
  }
}

module.exports = { verifyWebhook, verifySubscription, acceptPayload, ingestMessage, sendText };
