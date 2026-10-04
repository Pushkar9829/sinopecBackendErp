const crypto = require('crypto');
const { uploadBuffer } = require('../../utils/storage');
const { getSettings } = require('./intake.settings');
const { createDraft } = require('./intake.service');
const { parseKeywords, findKeywords } = require('./intake.keywords');

function signaturesMatch(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(String(header));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function downloadMedia(mediaId, token) {
  const meta = await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const info = await meta.json().catch(() => ({}));
  if (!meta.ok || !info.url) {
    throw new Error(info?.error?.message || 'WhatsApp media lookup failed');
  }
  const file = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!file.ok) throw new Error('WhatsApp media download failed');
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = info.mime_type || file.headers.get('content-type') || 'application/octet-stream';
  const ext = mimeType.includes('pdf') ? '.pdf' : mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
  return uploadBuffer({
    buffer,
    originalName: `${mediaId}${ext}`,
    mimeType,
    folder: 'intake',
  });
}

function messageText(message) {
  if (message.type === 'text') return message.text?.body || '';
  if (message.type === 'image') return message.image?.caption || '';
  if (message.type === 'document') return message.document?.caption || message.document?.filename || '';
  if (message.type === 'audio') return '';
  return message.caption || '';
}

async function storeMessage(message, contactName, settings) {
  const files = [];
  const warnings = [];
  const media = message.image || message.document || message.audio || null;
  if (media?.id && settings.whatsappAccessToken) {
    try {
      files.push(await downloadMedia(media.id, settings.whatsappAccessToken));
    } catch (error) {
      warnings.push(error.message);
    }
  } else if (media?.id) {
    warnings.push('WhatsApp access token is not set, so the file was not downloaded.');
  }

  const body = messageText(message);
  const searchable = [body, message.document?.filename || ''].join('\n');
  const matched = findKeywords(searchable, parseKeywords(settings.orderKeywords));
  const isDocument = message.type === 'document' || message.type === 'image';
  const potentialOrder = matched.length > 0 || (isDocument && files.length > 0 && !body.trim());
  const result = await createDraft({
    channel: 'whatsapp',
    providerMessageId: message.id,
    sender: { phone: message.from || '', email: '', name: contactName || '' },
    rawBody: body,
    files,
    potentialOrder,
    matchedKeywords: matched,
    status: potentialOrder ? 'received' : 'stored',
    warnings,
    receivedAt: message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date(),
  });
  return result;
}

async function ingestPayload(payload) {
  const settings = await getSettings();
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change.value || {};
      const name = value.contacts?.[0]?.profile?.name || '';
      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        if (!message.id) continue;
        await storeMessage(message, name, settings);
      }
    }
  }
}

function verifyWebhook(req) {
  return getSettings().then((settings) => signaturesMatch(req.rawBody, req.get('x-hub-signature-256'), settings.whatsappAppSecret));
}

module.exports = {
  ingestPayload,
  verifyWebhook,
};
