const { randomUUID } = require('crypto');
const { nextSeq } = require('../../utils/counter');
const ApiError = require('../../utils/ApiError');
const { uploadBuffer } = require('../../utils/storage');
const repo = require('./intake.repo');
const { getSettings, presentSettings, saveSettings } = require('./intake.settings');
const { readIntake, normalizeProposal } = require('./intake.reader');

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
      proposal: fields.proposal || null,
      status: fields.status || 'received',
      error: '',
      receivedAt: fields.receivedAt || new Date(),
      createdBy: fields.createdBy || '',
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

async function loadDraft(id) {
  const doc = await repo.findById(id);
  if (!doc) throw new ApiError(404, 'Draft not found');
  return doc;
}

async function getDraft(id) {
  return present(await loadDraft(id));
}

function userLabel(user) {
  return String(user?.name || user?.fullName || user?.username || '').trim();
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

function cleanSender(sender) {
  return {
    name: String(sender?.name || '').trim(),
    phone: String(sender?.phone || '').trim(),
    email: String(sender?.email || '').trim(),
  };
}

async function storeUploads(files) {
  const stored = [];
  for (const file of files || []) {
    if (!file?.buffer?.length) continue;
    stored.push(
      await uploadBuffer({
        buffer: file.buffer,
        originalName: file.originalname,
        mimeType: file.mimetype,
        folder: 'intake',
      })
    );
  }
  return stored;
}

async function readNow(id) {
  const claimed = await repo.claimById(id);
  await finishRead(claimed);
  return getDraft(id);
}

async function createPanelDraft({ proposal, sender, rawBody, subject }, user) {
  const normalized = normalizeProposal(proposal || {}, []);
  normalized.warnings = [];
  const filledSender = cleanSender(sender);
  if (!filledSender.name) filledSender.name = normalized.customer.name || normalized.customer.companyName;
  if (!filledSender.phone) filledSender.phone = normalized.customer.mobile;
  if (!filledSender.email) filledSender.email = normalized.customer.email;
  if (!normalized.customer.name && !normalized.customer.companyName && !normalized.lines.length) {
    throw new ApiError(400, 'Add a customer name or at least one line');
  }
  const saved = await createDraft({
    channel: 'panel',
    providerMessageId: `panel-${randomUUID()}`,
    sender: filledSender,
    subject: String(subject || '').trim(),
    rawBody: String(rawBody || '').trim(),
    files: [],
    potentialOrder: true,
    proposal: normalized,
    status: 'needs_review',
    createdBy: userLabel(user),
  });
  return present(saved.doc);
}

async function readPanelDraft({ text, sender }, files, user) {
  const body = String(text || '').trim();
  const stored = await storeUploads(files);
  if (!body && !stored.length) throw new ApiError(400, 'Paste a message or attach a photo or PDF');
  const saved = await createDraft({
    channel: 'panel',
    providerMessageId: `panel-${randomUUID()}`,
    sender: cleanSender(sender),
    rawBody: body,
    files: stored,
    potentialOrder: true,
    status: 'received',
    createdBy: userLabel(user),
  });
  return readNow(saved.doc._id);
}

async function pasteDraft(text, user) {
  return readPanelDraft({ text }, [], user);
}

async function updateProposal(id, payload, user) {
  const doc = await loadDraft(id);
  if (doc.status === 'reading') throw new ApiError(409, 'The reader is still working on this draft');
  if (doc.status === 'discarded') throw new ApiError(409, 'This draft was discarded');
  const normalized = normalizeProposal(payload?.proposal || {}, []);
  normalized.warnings = doc.proposal?.warnings || [];
  doc.proposal = normalized;
  doc.potentialOrder = true;
  doc.status = 'needs_review';
  doc.error = '';
  doc.editedBy = userLabel(user);
  doc.editedAt = new Date();
  doc.markModified('proposal');
  await doc.save();
  return present(doc);
}

async function markPotential(id) {
  const doc = await loadDraft(id);
  if (doc.status === 'reading') throw new ApiError(409, 'The reader is still working on this draft');
  doc.potentialOrder = true;
  doc.status = 'received';
  doc.error = '';
  await doc.save();
  return readNow(doc._id);
}

async function markNotOrder(id) {
  const doc = await loadDraft(id);
  if (doc.status === 'reading') throw new ApiError(409, 'The reader is still working on this draft');
  doc.potentialOrder = false;
  doc.status = 'stored';
  doc.error = '';
  await doc.save();
  return present(doc);
}

async function discardDraft(id) {
  const doc = await loadDraft(id);
  doc.status = 'discarded';
  await doc.save();
  return present(doc);
}

async function rereadDraft(id) {
  const doc = await loadDraft(id);
  if (doc.status === 'reading') throw new ApiError(409, 'The reader is still working on this draft');
  doc.potentialOrder = true;
  doc.status = 'received';
  doc.error = '';
  await doc.save();
  return readNow(doc._id);
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
  createPanelDraft,
  readPanelDraft,
  updateProposal,
  markPotential,
  markNotOrder,
  discardDraft,
  rereadDraft,
  processNext,
  settingsView,
  updateSettings,
};
