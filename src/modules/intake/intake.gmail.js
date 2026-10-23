const crypto = require('crypto');
const path = require('path');
const { google } = require('googleapis');
const jwt = require('jsonwebtoken');
const env = require('../../config/env');
const { COOKIES } = require('../../config/constants');
const { verifyAccessToken } = require('../../utils/tokens');
const upload = require('../../middlewares/upload');
const { hasPermission } = require('../../utils/permissions');
const { uploadBuffer } = require('../../utils/storage');
const jobs = require('../../utils/jobQueue');
const Intake = require('./intake.model');
const { getSettings, updateSettingsFields } = require('./intake.settings');
const { parseKeywords, findKeywords } = require('./intake.keywords');
const { htmlToText, parseAddress } = require('./intake.text');

// Attachments kept per message; anything beyond is listed but not stored.
const MAX_FILES = 10;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
// First connection: only this much recent mail is read, not the whole mailbox.
const FIRST_SYNC_QUERY = 'in:inbox newer_than:2d';

let clientFactory = null;

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

function gmailFor(settings) {
  if (clientFactory) return clientFactory(settings);
  return google.gmail({ version: 'v1', auth: oauthClient(settings) });
}

function connected(settings) {
  return Boolean(settings.gmailRefreshToken && settings.gmailClientId && settings.gmailClientSecret);
}

// The OAuth state is tied to the person who started the connection, with its
// own audience so it can never be used as (or confused with) an access token.
// Signed with a key derived from the access secret, so a state can't pass as
// an access token either.
const STATE_AUDIENCE = 'sinopec:gmail-oauth';
const stateSecret = () => crypto.createHmac('sha256', env.jwtAccessSecret).update(STATE_AUDIENCE).digest('hex');

function sessionUserId(req) {
  try {
    const token = req.cookies?.[COOKIES.ACCESS];
    return token ? String(verifyAccessToken(token).sub || '') : '';
  } catch {
    return '';
  }
}

async function startUrl(user) {
  const settings = await getSettings();
  if (!settings.gmailClientId || !settings.gmailClientSecret) {
    throw new Error('Save the Gmail client id and secret first');
  }
  if (!user?._id) throw new Error('Sign in again to connect Gmail');
  const state = jwt.sign({ purpose: 'gmail', sub: String(user._id) }, stateSecret(), {
    expiresIn: '15m',
    audience: STATE_AUDIENCE,
  });
  return oauthClient(settings).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    // Read mail, label it, and send replies in the same thread.
    scope: ['https://www.googleapis.com/auth/gmail.modify'],
    state,
  });
}

// sessionUserId: the signed-in user of the browser that came back from
// Google, when its session cookie is still readable.
async function finishCallback(code, state, sessionUserId = '') {
  let payload;
  try {
    payload = jwt.verify(state, stateSecret(), { audience: STATE_AUDIENCE });
  } catch {
    throw new Error('Gmail connection expired. Start it again from setup.');
  }
  if (payload.purpose !== 'gmail' || !payload.sub) throw new Error('Gmail connection was not recognised');
  if (sessionUserId && String(sessionUserId) !== String(payload.sub)) {
    throw new Error('Gmail connection was started by another user. Start it again from setup.');
  }
  const starter = await require('../user/user.repo').findByIdWithRole(payload.sub);
  if (!starter || !starter.isActive || !hasPermission(starter, 'intake:settings')) {
    throw new Error('Gmail connection was not recognised');
  }
  const settings = await getSettings();
  const client = oauthClient(settings);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token && !settings.gmailRefreshToken) {
    throw new Error('Google did not return a refresh token. Remove app access in the Google account and connect again.');
  }
  client.setCredentials(tokens);
  const profile = await google.gmail({ version: 'v1', auth: client }).users.getProfile({ userId: 'me' });
  const email = profile.data.emailAddress || settings.gmailEmail;
  await updateSettingsFields({
    gmailRefreshToken: tokens.refresh_token || settings.gmailRefreshToken,
    gmailEmail: email,
    // A different mailbox starts from now, not from the old one's position.
    gmailHistoryId: email === settings.gmailEmail ? settings.gmailHistoryId : '',
    gmailLastError: '',
  });
  return email;
}

async function disconnect() {
  await updateSettingsFields({ gmailRefreshToken: '', gmailHistoryId: '', gmailLastError: '' });
}

// ---------------------------------------------------------------- sync

async function queueMessage(id) {
  await jobs.enqueue('gmail:message', { messageId: id }, { key: `gmail:message:${id}`, maxAttempts: 5 });
}

async function firstSync(gmail) {
  const listed = await gmail.users.messages.list({ userId: 'me', q: FIRST_SYNC_QUERY, maxResults: 50 });
  for (const item of listed.data.messages || []) await queueMessage(item.id);
  const profile = await gmail.users.getProfile({ userId: 'me' });
  return String(profile.data.historyId || '');
}

// Job: picks up mail that arrived since the last sync (Gmail history API).
async function sync() {
  const settings = await getSettings();
  if (!connected(settings)) return;
  const gmail = gmailFor(settings);
  let historyId = settings.gmailHistoryId;
  try {
    if (!historyId) {
      historyId = await firstSync(gmail);
    } else {
      let pageToken;
      let latest = historyId;
      do {
        let response;
        try {
          response = await gmail.users.history.list({
            userId: 'me',
            startHistoryId: historyId,
            historyTypes: ['messageAdded'],
            labelId: 'INBOX',
            maxResults: 500,
            pageToken,
          });
        } catch (error) {
          // History older than about a week is gone: start again from recent mail.
          if (Number(error?.code || error?.status || error?.response?.status) === 404) {
            latest = await firstSync(gmail);
            pageToken = undefined;
            break;
          }
          throw error;
        }
        for (const row of response.data.history || []) {
          for (const added of row.messagesAdded || []) {
            const labels = added.message?.labelIds || [];
            if (added.message?.id && !labels.includes('SENT') && !labels.includes('DRAFT')) await queueMessage(added.message.id);
          }
        }
        if (response.data.historyId) latest = String(response.data.historyId);
        pageToken = response.data.nextPageToken;
      } while (pageToken);
      historyId = latest;
    }
    await updateSettingsFields({ gmailHistoryId: historyId, gmailLastSyncAt: new Date(), gmailLastError: '' });
  } catch (error) {
    await updateSettingsFields({ gmailLastError: String(error.message || error).slice(0, 500), gmailLastSyncAt: new Date() });
    throw error;
  }
}

// ---------------------------------------------------------------- one message

function headerValue(headers, name) {
  const found = (headers || []).find((item) => String(item.name || '').toLowerCase() === name);
  return found?.value || '';
}

function decode(data) {
  if (!data) return Buffer.alloc(0);
  return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function walkParts(part, bucket) {
  if (!part) return;
  const mime = String(part.mimeType || '');
  if (part.filename && (part.body?.attachmentId || part.body?.data)) {
    bucket.attachments.push({ id: part.body.attachmentId, data: part.body.data, filename: part.filename, mimeType: mime, size: Number(part.body.size) || 0 });
    return;
  }
  if (mime === 'text/plain' && part.body?.data) bucket.text.push(decode(part.body.data).toString('utf8'));
  if (mime === 'text/html' && part.body?.data) bucket.html.push(decode(part.body.data).toString('utf8'));
  for (const child of part.parts || []) walkParts(child, bucket);
}

function allowedFile(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return upload.IMAGE_EXT.has(ext) || ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.txt'].includes(ext);
}

// Newsletters and mailing lists: never orders, never answered.
function isBulk(headers, fromEmail) {
  const precedence = headerValue(headers, 'precedence').toLowerCase();
  return (
    ['bulk', 'list', 'junk'].includes(precedence) ||
    Boolean(headerValue(headers, 'list-id')) ||
    Boolean(headerValue(headers, 'list-unsubscribe')) ||
    /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?)@/i.test(fromEmail)
  );
}

function isAutomated(headers, fromEmail) {
  const auto = headerValue(headers, 'auto-submitted').toLowerCase();
  return (auto && auto !== 'no') || Boolean(headerValue(headers, 'x-autoreply')) || isBulk(headers, fromEmail);
}

async function downloadAttachments(gmail, messageId, attachments) {
  const files = [];
  const notes = [];
  let total = 0;
  for (const attachment of attachments) {
    if (!allowedFile(attachment.filename)) {
      notes.push(`${attachment.filename} (file type not kept)`);
      continue;
    }
    if (files.length >= MAX_FILES || attachment.size > MAX_FILE_BYTES || total + attachment.size > MAX_TOTAL_BYTES) {
      notes.push(`${attachment.filename} (too large or too many files)`);
      continue;
    }
    let buffer = attachment.data ? decode(attachment.data) : null;
    if (!buffer) {
      const downloaded = await gmail.users.messages.attachments.get({ userId: 'me', messageId, id: attachment.id });
      buffer = decode(downloaded.data.data);
    }
    if (!buffer.length) continue;
    total += buffer.length;
    files.push(await uploadBuffer({ buffer, originalName: attachment.filename, mimeType: attachment.mimeType, folder: 'intake' }));
  }
  return { files, notes };
}

async function potentialOrderLabelId(gmail) {
  const listed = await gmail.users.labels.list({ userId: 'me' });
  const existing = (listed.data.labels || []).find((label) => label.name === 'Potential order');
  if (existing?.id) return existing.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: 'Potential order', labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  return created.data.id;
}

// Job: stores one Gmail message in its thread's draft.
async function fetchMessage({ messageId }) {
  const service = require('./intake.service');
  if (await Intake.exists({ channel: 'gmail', messageIds: messageId })) return;
  const settings = await getSettings();
  if (!connected(settings)) return;
  const gmail = gmailFor(settings);
  let full;
  try {
    full = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  } catch (error) {
    if (Number(error?.code || error?.status) === 404) return; // deleted before we got to it
    throw error;
  }
  const labels = full.data.labelIds || [];
  if (labels.some((label) => ['SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(label))) return;
  const headers = full.data.payload?.headers || [];
  const from = parseAddress(headerValue(headers, 'from'));
  // Our own mail (including our automatic replies) is never an order.
  if (from.email && settings.gmailEmail && from.email === settings.gmailEmail.toLowerCase()) return;

  const bucket = { text: [], html: [], attachments: [] };
  walkParts(full.data.payload, bucket);
  const subject = headerValue(headers, 'subject');
  const text = bucket.text.join('\n').trim() || htmlToText(bucket.html.join('\n'));
  const bulk = isBulk(headers, from.email);
  const names = bucket.attachments.map((a) => a.filename).join('\n');
  const matched = bulk ? [] : findKeywords(`${subject}\n${text}\n${names}`, parseKeywords(settings.orderKeywords));
  const potentialOrder = matched.length > 0;

  // Files are only downloaded for possible orders; other mail keeps the names.
  let files = [];
  let notes = [];
  if (potentialOrder) ({ files, notes } = await downloadAttachments(gmail, messageId, bucket.attachments));
  else notes = bucket.attachments.map((a) => a.filename);
  const body = notes.length ? `${text}\n\n[Attachments not stored: ${notes.join(', ')}]` : text;

  const { doc, created, duplicate } = await service.ingestMessage({
    channel: 'gmail',
    conversationKey: full.data.threadId || messageId,
    message: {
      providerMessageId: messageId,
      from: from.email,
      fromName: from.name,
      subject,
      body,
      headerMessageId: headerValue(headers, 'message-id'),
      automated: isAutomated(headers, from.email),
      receivedAt: full.data.internalDate ? new Date(Number(full.data.internalDate)) : new Date(),
    },
    files,
    sender: { email: from.email, name: from.name },
    matchedKeywords: matched,
    potentialOrder,
  });
  if (duplicate) return;
  await service.scheduleRead(doc);
  if (created && potentialOrder) {
    try {
      const labelId = await potentialOrderLabelId(gmail);
      await gmail.users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds: [labelId] } });
    } catch (error) {
      console.error('Gmail label was not applied:', error.message);
    }
  }
}

// A stored (non-order) mail marked as an order: fetch the files it skipped.
async function fetchSkippedAttachments(intakeId) {
  const doc = await Intake.findById(intakeId);
  if (!doc || doc.channel !== 'gmail') return;
  const settings = await getSettings();
  if (!connected(settings)) return;
  const gmail = gmailFor(settings);
  for (const message of doc.messages) {
    if (message.fileIds.length || !/\[Attachments not stored:/.test(message.body)) continue;
    const full = await gmail.users.messages.get({ userId: 'me', id: message.providerMessageId, format: 'full' });
    const bucket = { text: [], html: [], attachments: [] };
    walkParts(full.data.payload, bucket);
    const { files } = await downloadAttachments(gmail, message.providerMessageId, bucket.attachments);
    if (!files.length) continue;
    const withIds = files.map((file) => ({ ...file, _id: new (require('mongoose').Types.ObjectId)() }));
    await Intake.updateOne(
      { _id: doc._id, 'messages._id': message._id },
      { $push: { files: { $each: withIds } }, $set: { 'messages.$.fileIds': withIds.map((f) => f._id) } }
    );
  }
}

// ---------------------------------------------------------------- reply

function encodeHeader(value) {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

async function sendReply(intake, to, text) {
  const settings = await getSettings();
  if (!connected(settings)) throw new Error('Gmail is not connected');
  const gmail = gmailFor(settings);
  const last = [...intake.messages].reverse().find((m) => m.headerMessageId) || intake.messages[intake.messages.length - 1];
  const subject = intake.subject ? (/^re:/i.test(intake.subject) ? intake.subject : `Re: ${intake.subject}`) : 'Your order request';
  const lines = [
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'Auto-Submitted: auto-replied',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  if (last?.headerMessageId) {
    lines.push(`In-Reply-To: ${last.headerMessageId}`);
    lines.push(`References: ${last.headerMessageId}`);
  }
  const raw = `${lines.join('\r\n')}\r\n\r\n${Buffer.from(text).toString('base64')}`;
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(raw).toString('base64url'), threadId: intake.conversationKey || undefined },
  });
}

function frontendRedirect(query) {
  return `${env.clientOrigin.replace(/\/$/, '')}/draft-orders/setup?${query}`;
}

module.exports = {
  startUrl,
  sessionUserId,
  finishCallback,
  disconnect,
  sync,
  fetchMessage,
  fetchSkippedAttachments,
  sendReply,
  frontendRedirect,
  isAutomated,
  // Tests swap the Gmail client for a fake one.
  setClientFactory(factory) {
    clientFactory = factory;
  },
};
