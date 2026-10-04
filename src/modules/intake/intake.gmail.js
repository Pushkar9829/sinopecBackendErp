const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const env = require('../../config/env');
const { uploadBuffer } = require('../../utils/storage');
const { getSettings } = require('./intake.settings');
const { createDraft } = require('./intake.service');

function redirectUri(settings) {
  const base = String(settings.publicBaseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('Set the public website address in Draft orders setup first');
  return `${base}/api/intake/gmail/callback`;
}

function oauthClient(settings) {
  const client = new google.auth.OAuth2(settings.gmailClientId, settings.gmailClientSecret, redirectUri(settings));
  if (settings.gmailRefreshToken) client.setCredentials({ refresh_token: settings.gmailRefreshToken });
  return client;
}

async function startUrl() {
  const settings = await getSettings();
  if (!settings.gmailClientId || !settings.gmailClientSecret) {
    throw new Error('Save the Gmail client id and secret first');
  }
  const state = jwt.sign({ purpose: 'gmail' }, env.jwtAccessSecret, { expiresIn: '15m' });
  const url = oauthClient(settings).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/gmail.modify'],
    state,
  });
  return url;
}

async function finishCallback(code, state) {
  let payload;
  try {
    payload = jwt.verify(state, env.jwtAccessSecret);
  } catch {
    throw new Error('Gmail connection expired. Start it again from setup.');
  }
  if (payload.purpose !== 'gmail') throw new Error('Gmail connection was not recognised');
  const settings = await getSettings();
  const client = oauthClient(settings);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token && !settings.gmailRefreshToken) {
    throw new Error('Google did not return a refresh token. Remove app access in the Google account and connect again.');
  }
  client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const profile = await gmail.users.getProfile({ userId: 'me' });
  settings.gmailRefreshToken = tokens.refresh_token || settings.gmailRefreshToken;
  settings.gmailEmail = profile.data.emailAddress || settings.gmailEmail;
  await settings.save();
  return settings.gmailEmail;
}

function headerValue(headers, name) {
  const found = (headers || []).find((item) => String(item.name || '').toLowerCase() === name);
  return found?.value || '';
}

function decodeBody(data) {
  if (!data) return '';
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function walkParts(part, bucket) {
  if (!part) return;
  const mime = String(part.mimeType || '');
  const filename = part.filename || '';
  if (part.body?.attachmentId && filename) {
    bucket.attachments.push({ id: part.body.attachmentId, filename, mimeType: mime });
    return;
  }
  if (mime === 'text/plain' && part.body?.data) bucket.text.push(decodeBody(part.body.data));
  if (mime === 'text/html' && part.body?.data) bucket.html.push(decodeBody(part.body.data));
  for (const child of part.parts || []) walkParts(child, bucket);
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function pollUnread() {
  const settings = await getSettings();
  if (!settings.gmailRefreshToken || !settings.gmailClientId || !settings.gmailClientSecret) return;
  const client = oauthClient(settings);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const listed = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread newer_than:7d',
    maxResults: 5,
  });
  const messages = listed.data.messages || [];
  for (const item of messages) {
    const full = await gmail.users.messages.get({ userId: 'me', id: item.id, format: 'full' });
    const bucket = { text: [], html: [], attachments: [] };
    walkParts(full.data.payload, bucket);
    const headers = full.data.payload?.headers || [];
    const files = [];
    for (const attachment of bucket.attachments) {
      const downloaded = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: item.id,
        id: attachment.id,
      });
      const buffer = Buffer.from(String(downloaded.data.data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      if (!buffer.length) continue;
      files.push(
        await uploadBuffer({
          buffer,
          originalName: attachment.filename,
          mimeType: attachment.mimeType || 'application/octet-stream',
          folder: 'intake',
        })
      );
    }
    const text = bucket.text.join('\n').trim() || htmlToText(bucket.html.join('\n'));
    const saved = await createDraft({
      channel: 'gmail',
      providerMessageId: full.data.id,
      sender: {
        phone: '',
        email: headerValue(headers, 'from'),
        name: '',
      },
      rawBody: text,
      files,
      warnings: [],
      receivedAt: full.data.internalDate ? new Date(Number(full.data.internalDate)) : new Date(),
    });
    if (saved.doc) {
      await gmail.users.messages.modify({
        userId: 'me',
        id: item.id,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    }
  }
}

function frontendRedirect(query) {
  const origin = String(env.clientOrigin || 'http://localhost:5173').split(',')[0].trim();
  return `${origin}/draft-orders/setup?${query}`;
}

module.exports = {
  startUrl,
  finishCallback,
  pollUnread,
  frontendRedirect,
};
