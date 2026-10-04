const { nextSeq } = require('../../utils/counter');
const repo = require('./intake.repo');
const { getSettings, presentSettings, saveSettings } = require('./intake.settings');
const { readIntake } = require('./intake.reader');

async function nextIntakeNumber() {
  const year = new Date().getFullYear();
  const seq = await nextSeq(`intake:${year}`);
  return `IN-${year}-${String(seq).padStart(5, '0')}`;
}

function present(doc) {
  if (!doc) return null;
  const json = typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
  return json;
}

async function createDraft(fields) {
  const existing = await repo.findByProvider(fields.channel, fields.providerMessageId);
  if (existing) return { doc: existing, created: false };
  try {
    const doc = await repo.Intake.create({
      number: await nextIntakeNumber(),
      channel: fields.channel,
      providerMessageId: fields.providerMessageId,
      sender: fields.sender || {},
      subject: fields.subject || '',
      rawBody: fields.rawBody || '',
      files: fields.files || [],
      warnings: fields.warnings || [],
      potentialOrder: Boolean(fields.potentialOrder),
      matchedKeywords: fields.matchedKeywords || [],
      proposal: null,
      status: fields.status || 'received',
      error: '',
      receivedAt: fields.receivedAt || new Date(),
    });
    return { doc, created: true };
  } catch (error) {
    if (error && error.code === 11000) {
      const again = await repo.findByProvider(fields.channel, fields.providerMessageId);
      return { doc: again, created: false };
    }
    throw error;
  }
}

async function listDrafts() {
  const rows = await repo.list();
  return rows.map(present);
}

async function getDraft(id) {
  const doc = await repo.findById(id);
  if (!doc) {
    const ApiError = require('../../utils/ApiError');
    throw new ApiError(404, 'Draft not found');
  }
  return present(doc);
}

async function finishRead(doc) {
  if (!doc) return null;
  try {
    const proposal = await readIntake(doc);
    doc.proposal = proposal;
    doc.warnings = proposal.warnings || [];
    doc.status = 'needs_review';
    doc.error = '';
  } catch (error) {
    doc.status = 'reading_failed';
    doc.error = error.message || 'Reading failed';
  }
  await doc.save();
  return doc;
}

async function pasteDraft(text) {
  const body = String(text || '').trim();
  if (!body) {
    const ApiError = require('../../utils/ApiError');
    throw new ApiError(400, 'Type a message to test');
  }
  const saved = await createDraft({
    channel: 'paste',
    providerMessageId: `paste-${Date.now()}`,
    sender: { name: 'Paste test', phone: '', email: '' },
    rawBody: body,
    files: [],
  });
  const claimed = await repo.claimById(saved.doc._id);
  await finishRead(claimed);
  return getDraft(saved.doc._id);
}

async function discardDraft(id) {
  const doc = await repo.findById(id);
  if (!doc) {
    const ApiError = require('../../utils/ApiError');
    throw new ApiError(404, 'Draft not found');
  }
  doc.status = 'discarded';
  await doc.save();
  return present(doc);
}

async function rereadDraft(id) {
  const doc = await repo.findById(id);
  if (!doc) {
    const ApiError = require('../../utils/ApiError');
    throw new ApiError(404, 'Draft not found');
  }
  doc.status = 'received';
  doc.error = '';
  await doc.save();
  const claimed = await repo.claimById(doc._id);
  await finishRead(claimed);
  return getDraft(id);
}

async function processNext() {
  return finishRead(await repo.claimNextReceived());
}

async function settingsView() {
  return presentSettings(await getSettings());
}

async function updateSettings(payload) {
  return presentSettings(await saveSettings(payload));
}

module.exports = {
  createDraft,
  listDrafts,
  getDraft,
  pasteDraft,
  discardDraft,
  rereadDraft,
  processNext,
  settingsView,
  updateSettings,
};
