// Text helpers for incoming mail and chat.

// Drops the quoted history under a reply ("On Mon, X wrote:", "> ..." lines,
// Outlook's "-----Original Message-----" / "From: ... Sent: ..." block), so
// each message in a thread is read once.
const CUT_MARKERS = [
  /^\s*On .{3,200}wrote:\s*$/im,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^\s*_{5,}\s*$/m,
  /^\s*From:\s.*\n\s*(Sent|Date):\s/im,
  /^\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}.{0,80}<[^>]+@[^>]+>.{0,20}:\s*$/m,
];

function stripQuoted(text) {
  let body = String(text || '').replace(/\r\n/g, '\n');
  let cut = body.length;
  for (const marker of CUT_MARKERS) {
    const match = marker.exec(body);
    if (match && match.index > 0 && match.index < cut) cut = match.index;
  }
  body = body.slice(0, cut);
  return body
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// "Name <a@b.c>" → { name, email }
function parseAddress(value) {
  const text = String(value || '').trim();
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email = match ? match[0].toLowerCase() : '';
  const name = text
    .replace(/<[^>]*>/g, '')
    .replace(email, '')
    .replace(/["']/g, '')
    .trim();
  return { name, email };
}

// The text the reader sees for a conversation: every message, oldest first.
function conversationText(messages) {
  const list = [...(messages || [])].sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
  if (list.length <= 1) return String(list[0]?.body || '').trim();
  return list
    .map((message, index) => {
      // Written out (not YYYY-MM-DD) so the reader doesn't take it for a delivery date.
      const when = message.receivedAt
        ? new Date(message.receivedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
        : '';
      return `--- Message ${index + 1}${when ? `, sent ${when}` : ''} ---\n${String(message.body || '').trim()}`;
    })
    .join('\n\n')
    .trim();
}

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normalizeGst(value) {
  return String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

module.exports = { stripQuoted, htmlToText, parseAddress, conversationText, normalizePhone, normalizeGst };
