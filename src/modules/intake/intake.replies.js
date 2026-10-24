const Intake = require('./intake.model');
const { getSettings } = require('./intake.settings');
const { normalizePhone, parseAddress } = require('./intake.text');

// Automatic "we received your order" reply: at most one per conversation,
// a daily cap per sender, never to automated mail, and in test mode only to
// the listed numbers / addresses.
function recipientOf(intake) {
  if (intake.channel === 'gmail') return parseAddress(intake.sender?.email).email;
  if (intake.channel === 'whatsapp') return String(intake.sender?.phone || '').replace(/\D/g, '');
  return '';
}

function inTestList(settings, channel, to) {
  const entries = String(settings.autoReplyTestRecipients || '')
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (channel === 'gmail') return entries.some((item) => item.toLowerCase() === to.toLowerCase());
  return entries.some((item) => normalizePhone(item) && normalizePhone(item) === normalizePhone(to));
}

function fillTemplate(text, intake) {
  return String(text || '')
    .replace(/\{number\}/g, intake.number)
    .replace(/\{name\}/g, intake.sender?.name || '')
    .trim();
}

async function sentTodayTo(channel, to) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return Intake.countDocuments({ channel, replies: { $elemMatch: { to, status: 'sent', at: { $gte: since } } } });
}

async function record(intakeId, entry) {
  await Intake.updateOne({ _id: intakeId }, { $push: { replies: { at: new Date(), ...entry } } });
}

// Checks every automatic message goes through: sender, test mode, daily cap.
async function senderSkip(intake, settings, to) {
  if (!to) return 'No address to reply to';
  const last = intake.messages[intake.messages.length - 1];
  if (last?.automated) return 'Automated mail is never answered';
  if (intake.channel === 'gmail' && settings.gmailEmail && to === settings.gmailEmail.toLowerCase()) return 'Our own address';
  if (settings.autoReplyTestMode && !inTestList(settings, intake.channel, to)) return 'Test mode: not on the test list';
  if ((await sentTodayTo(intake.channel, to)) >= (settings.autoReplyDailyPerSender || 0)) return 'Daily reply limit for this sender reached';
  return '';
}

async function decide(intake, settings, to) {
  if (!settings.autoReplyEnabled) return 'Automatic replies are switched off';
  if ((intake.replies || []).some((reply) => reply.status === 'sent' && reply.kind !== 'booked')) return 'Already answered';
  if (!to) return 'No address to reply to';
  if (['discarded', 'stored', 'converted'].includes(intake.status)) return 'Not an open order';
  return senderSkip(intake, settings, to);
}

// Job handler.
async function sendReply({ intakeId }) {
  const intake = await Intake.findById(intakeId);
  if (!intake) return;
  const settings = await getSettings();
  const to = recipientOf(intake);
  const skip = await decide(intake, settings, to);
  if (skip) {
    await record(intakeId, { channel: intake.channel, to, status: 'skipped', reason: skip });
    return;
  }
  const text = fillTemplate(settings.autoReplyText, intake);
  try {
    if (intake.channel === 'gmail') await require('./intake.gmail').sendReply(intake, to, text);
    else await require('./intake.whatsapp').sendText(intake, to, text);
    await record(intakeId, { channel: intake.channel, to, status: 'sent', text });
  } catch (error) {
    await record(intakeId, { channel: intake.channel, to, status: error.skip ? 'skipped' : 'failed', reason: String(error.message).slice(0, 300) });
    if (!error.skip) throw error;
  }
}

// After a convert: "Your order is booked as SO-…" on WhatsApp, once per draft.
// Returns { status: 'sent' | 'skipped' | 'failed', reason }; never throws.
async function confirmBooked(intake) {
  const settings = await getSettings();
  const to = recipientOf(intake);
  let skip = '';
  if (intake.channel !== 'whatsapp') skip = 'Only sent on WhatsApp';
  else if (settings.confirmConvertedWhatsapp === false) skip = 'Order confirmations are switched off';
  else if (intake.status !== 'converted' || !intake.salesOrderNumber) skip = 'Not converted';
  else if ((intake.replies || []).some((reply) => reply.kind === 'booked' && reply.status === 'sent')) skip = 'Already confirmed';
  else skip = await senderSkip(intake, settings, to);
  if (skip) {
    await record(intake._id, { channel: intake.channel, to, kind: 'booked', status: 'skipped', reason: skip });
    return { status: 'skipped', reason: skip };
  }
  const text = `Thank you. Your order is booked as ${intake.salesOrderNumber}.`;
  try {
    await require('./intake.whatsapp').sendText(intake, to, text);
    await record(intake._id, { channel: intake.channel, to, kind: 'booked', status: 'sent', text });
    return { status: 'sent', reason: '' };
  } catch (error) {
    const status = error.skip ? 'skipped' : 'failed';
    const reason = String(error.message).slice(0, 300);
    await record(intake._id, { channel: intake.channel, to, kind: 'booked', status, reason }).catch(() => {});
    return { status, reason };
  }
}

module.exports = { sendReply, confirmBooked };
