const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const { TASK_STATUSES, PRODUCTION_ROUTE_LIST } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { nextSeq } = require('../../utils/counter');
const { hasPermission } = require('../../utils/permissions');
const { uploadBuffer, readStoredObject, deleteStoredObject } = require('../../utils/storage');
const { businessYmd } = require('../../utils/businessTime');
const jobs = require('../../utils/jobQueue');
const Intake = require('./intake.model');
const { getSettings } = require('./intake.settings');
const { readIntake, normalizeProposal } = require('./intake.reader');
const { conversationText, stripQuoted } = require('./intake.text');
const { matchCustomer, suggestProducts } = require('./intake.matching');
const { DailyLimitReached } = require('./ai');
const reviewTasks = require('./intake.tasks');

const MAX_READINGS = 10;
const LIST_FIELDS = '-messages -readings -rawBody -history -replies -customerMatch';
const READABLE = ['received', 'reading', 'reading_failed', 'needs_review', 'customer_confirmed'];

async function nextIntakeNumber() {
  const year = new Date().getFullYear();
  const seq = await nextSeq(`intake:${year}`);
  return `IN-${year}-${String(seq).padStart(5, '0')}`;
}

function userLabel(user) {
  return String(user?.fullName || user?.username || '').trim();
}

function historyEntry(user, action, note = '') {
  return { at: new Date(), by: user?._id || null, byName: userLabel(user) || 'System', action, note };
}

function present(doc) {
  if (!doc) return null;
  return typeof doc.toJSON === 'function' ? doc.toJSON() : doc;
}

async function loadDraft(id) {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Draft not found');
  const doc = await Intake.findById(id);
  if (!doc) throw new ApiError(404, 'Draft not found');
  return doc;
}

// Saves with the version check; a clash means someone else changed the draft.
async function saveChecked(doc) {
  try {
    await doc.save();
  } catch (error) {
    if (error instanceof mongoose.Error.VersionError) {
      throw new ApiError(409, 'This draft changed while you were working on it. Reload it and try again.');
    }
    throw error;
  }
}

function assertVersion(doc, version) {
  if (version !== undefined && version !== null && Number(version) !== doc.__v) {
    throw new ApiError(409, 'This draft changed while you were working on it. Reload it and try again.');
  }
}

// ---------------------------------------------------------------- ingest

// Adds one incoming message to its conversation's draft, or opens a new draft.
// message: { providerMessageId, from, fromName, subject, body, headerMessageId, automated, receivedAt }
// Returns { doc, created, duplicate }.
async function ingestMessage({ channel, conversationKey = '', windowMs = 0, message, files = [], sender = {}, matchedKeywords = [], potentialOrder = false, createdBy = '' }) {
  const messageId = String(message.providerMessageId);
  const existing = await Intake.findOne({ channel, messageIds: messageId });
  if (existing) return { doc: existing, created: false, duplicate: true };

  const receivedAt = message.receivedAt ? new Date(message.receivedAt) : new Date();
  const body = stripQuoted(message.body);
  const openKey = conversationKey ? `${channel}:${conversationKey}` : undefined;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let open = openKey ? await Intake.findOne({ openKey }) : null;
    if (open && windowMs && receivedAt - new Date(open.lastMessageAt) > windowMs) {
      // Too long since the last message: that conversation is finished.
      await Intake.updateOne({ _id: open._id, openKey }, { $unset: { openKey: 1 } });
      open = null;
    }
    const storedFiles = files.map((file) => ({ ...file, _id: new mongoose.Types.ObjectId() }));
    const entry = {
      _id: new mongoose.Types.ObjectId(),
      providerMessageId: messageId,
      from: message.from || '',
      fromName: message.fromName || '',
      subject: message.subject || '',
      body,
      headerMessageId: message.headerMessageId || '',
      automated: Boolean(message.automated),
      fileIds: storedFiles.map((file) => file._id),
      receivedAt,
    };

    if (open) {
      const updated = await Intake.findOneAndUpdate(
        { _id: open._id, openKey, messageIds: { $ne: messageId } },
        {
          $push: { messages: entry, files: { $each: storedFiles } },
          $addToSet: { messageIds: messageId, matchedKeywords: { $each: matchedKeywords } },
          $max: { lastMessageAt: receivedAt },
        },
        { new: true }
      );
      if (!updated) continue;
      const set = { rawBody: conversationText(updated.messages) };
      if (potentialOrder && !updated.potentialOrder) set.potentialOrder = true;
      if (potentialOrder && updated.status === 'stored' && !updated.bodyRemovedAt) set.status = 'received';
      await Intake.updateOne({ _id: updated._id }, { $set: set });
      Object.assign(updated, set);
      return { doc: updated, created: false, duplicate: false };
    }

    try {
      const doc = await Intake.create({
        number: await nextIntakeNumber(),
        channel,
        conversationKey,
        openKey,
        messageIds: [messageId],
        messages: [entry],
        sender: { name: sender.name || '', email: sender.email || '', phone: sender.phone || '' },
        subject: message.subject || '',
        rawBody: body,
        potentialOrder,
        matchedKeywords,
        files: storedFiles,
        status: potentialOrder ? 'received' : 'stored',
        receivedAt,
        lastMessageAt: receivedAt,
        createdBy,
        history: [historyEntry(null, 'received', `From ${channel}`)],
      });
      return { doc, created: true, duplicate: false };
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const again = await Intake.findOne({ channel, messageIds: messageId });
      if (again) return { doc: again, created: false, duplicate: true };
      // Another message opened this conversation a moment ago; join it.
    }
  }
  throw new Error('Could not store the message; it will be retried');
}

async function scheduleRead(doc) {
  if (!doc?.potentialOrder || !READABLE.includes(doc.status)) return;
  await Intake.updateOne({ _id: doc._id }, { $set: { readPending: true } });
  await jobs.enqueue('intake:read', { intakeId: String(doc._id) }, { key: `intake:read:${doc._id}`, maxAttempts: 4 });
}

// ---------------------------------------------------------------- reading

// Job handler: reads one draft with the AI reader.
async function runRead({ intakeId }, job) {
  const doc = await Intake.findById(intakeId);
  if (!doc || !doc.potentialOrder || !READABLE.includes(doc.status)) {
    if (doc) await Intake.updateOne({ _id: doc._id }, { $set: { readPending: false } });
    return;
  }
  const first = ['received', 'reading_failed', 'reading'].includes(doc.status);
  if (first) await Intake.updateOne({ _id: doc._id }, { $set: { status: 'reading', error: '' } });

  let result;
  try {
    let current = doc;
    if (doc.channel === 'gmail' && doc.messages.some((m) => !m.fileIds.length && /\[Attachments not stored:/.test(m.body))) {
      // Mail first stored as "not an order" kept only its file names.
      await require('./intake.gmail').fetchSkippedAttachments(doc._id);
      current = await Intake.findById(intakeId);
    }
    result = await readIntake(current);
  } catch (error) {
    const lastTry = !job || job.attempts >= job.maxAttempts || error.config;
    if (error instanceof DailyLimitReached) {
      await Intake.updateOne({ _id: doc._id }, { $set: { status: first ? 'received' : doc.status, error: error.message } });
      throw new jobs.JobDeferred(error.resumeAt, error.message);
    }
    const set = { error: error.message || 'Reading failed' };
    if (first) set.status = lastTry ? 'reading_failed' : 'received';
    if (lastTry) set.readPending = false;
    await Intake.updateOne(
      { _id: doc._id },
      { $set: set, $push: { readings: { $each: [{ at: new Date(), error: set.error }], $slice: -MAX_READINGS } } }
    );
    if (lastTry) return;
    throw error;
  }
  await applyReading(intakeId, result);
}

async function applyReading(intakeId, result) {
  const settings = await getSettings();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const doc = await Intake.findById(intakeId);
    if (!doc || ['converted', 'discarded'].includes(doc.status)) return;
    const reading = { at: new Date(), provider: result.provider, model: result.model, proposal: result.proposal };
    const notOrder = result.proposal.isOrder === false && ['gmail', 'whatsapp'].includes(doc.channel) && !doc.humanEdited && !doc.customer;
    if (doc.humanEdited) {
      doc.newReadingAvailable = true;
    } else {
      reading.applied = true;
      doc.proposal = result.proposal;
      doc.warnings = result.proposal.warnings || [];
      doc.newReadingAvailable = false;
      doc.markModified('proposal');
    }
    doc.readings.push(reading);
    if (doc.readings.length > MAX_READINGS) doc.readings.splice(0, doc.readings.length - MAX_READINGS);
    doc.error = '';
    doc.readPending = false;
    let becameReviewable = false;
    if (notOrder) {
      doc.status = 'stored';
      doc.potentialOrder = false;
      doc.history.push(historyEntry(null, 'not_order', 'The reader found no order in this message'));
    } else if (['received', 'reading', 'reading_failed'].includes(doc.status)) {
      doc.status = 'needs_review';
      doc.reviewDueAt = doc.reviewDueAt || new Date(Date.now() + (settings.reviewSlaHours || 4) * 60 * 60 * 1000);
      becameReviewable = true;
    }
    if (!doc.customer && doc.proposal) doc.customerMatch = await matchCustomer(doc.proposal, doc.sender);
    try {
      await doc.save();
    } catch (error) {
      if (error instanceof mongoose.Error.VersionError) continue;
      throw error;
    }
    if (notOrder) await reviewTasks.closeReviewTask(doc, TASK_STATUSES.CANCELLED, null, 'Not an order');
    if (becameReviewable) {
      await reviewTasks.ensureReviewTask(doc, settings.reviewSlaHours);
      await scheduleReply(doc, settings);
    }
    return;
  }
  throw new Error('The draft kept changing while the reading was saved');
}

async function scheduleReply(doc, settings) {
  if (!settings.autoReplyEnabled || !['gmail', 'whatsapp'].includes(doc.channel)) return;
  if ((doc.replies || []).some((reply) => reply.status === 'sent')) return;
  await jobs.enqueue('intake:reply', { intakeId: String(doc._id) }, { key: `intake:reply:${doc._id}`, maxAttempts: 3 });
}

// ---------------------------------------------------------------- panel

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
    stored.push(await uploadBuffer({ buffer: file.buffer, originalName: file.originalname, mimeType: file.mimetype, folder: 'intake' }));
  }
  return stored;
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
  const { doc } = await ingestMessage({
    channel: 'panel',
    message: { providerMessageId: `panel-${randomUUID()}`, from: filledSender.email || filledSender.phone, fromName: filledSender.name, subject, body: rawBody },
    sender: filledSender,
    potentialOrder: true,
    createdBy: userLabel(user),
  });
  const settings = await getSettings();
  doc.proposal = normalized;
  doc.humanEdited = true;
  doc.status = 'needs_review';
  doc.reviewDueAt = new Date(Date.now() + (settings.reviewSlaHours || 4) * 60 * 60 * 1000);
  doc.customerMatch = await matchCustomer(normalized, filledSender);
  doc.history.push(historyEntry(user, 'created', 'Typed on the panel'));
  await doc.save();
  return getDraft(doc._id);
}

async function readPanelDraft({ text, sender }, files, user) {
  const body = String(text || '').trim();
  const stored = await storeUploads(files);
  if (!body && !stored.length) throw new ApiError(400, 'Paste a message or attach a photo or PDF');
  const clean = cleanSender(sender);
  const { doc } = await ingestMessage({
    channel: 'panel',
    message: { providerMessageId: `panel-${randomUUID()}`, from: clean.email || clean.phone, fromName: clean.name, body },
    files: stored,
    sender: clean,
    potentialOrder: true,
    createdBy: userLabel(user),
  });
  // Panel reads run right away so the person sees the result.
  try {
    await runRead({ intakeId: String(doc._id) }, { attempts: 1, maxAttempts: 1 });
  } catch (error) {
    if (!(error instanceof jobs.JobDeferred)) throw error;
    await jobs.enqueue('intake:read', { intakeId: String(doc._id) }, { key: `intake:read:${doc._id}`, runAt: error.runAt });
  }
  return getDraft(doc._id);
}

// ---------------------------------------------------------------- views

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STATUS_GROUPS = {
  review: ['needs_review', 'customer_confirmed'],
  waiting: ['received', 'reading'],
  failed: ['reading_failed'],
  converted: ['converted'],
  not_order: ['stored'],
  discarded: ['discarded'],
};

async function listDrafts(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 25));
  const filter = {};
  if (query.channel && ['whatsapp', 'gmail', 'panel', 'paste'].includes(query.channel)) filter.channel = query.channel;
  const q = String(query.q || '').trim();
  if (q) {
    const pattern = new RegExp(escapeRegex(q.slice(0, 80)), 'i');
    filter.$or = [
      { number: pattern },
      { subject: pattern },
      { 'sender.name': pattern },
      { 'sender.email': pattern },
      { 'sender.phone': pattern },
      { customerName: pattern },
      { salesOrderNumber: pattern },
      { 'proposal.customer.name': pattern },
      { 'proposal.customer.companyName': pattern },
    ];
  }
  const countRows = await Intake.aggregate([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const byStatus = Object.fromEntries(countRows.map((row) => [row._id, row.n]));
  const counts = { all: countRows.reduce((sum, row) => sum + row.n, 0) };
  for (const [group, statuses] of Object.entries(STATUS_GROUPS)) counts[group] = statuses.reduce((sum, s) => sum + (byStatus[s] || 0), 0);

  const group = STATUS_GROUPS[query.status];
  const pageFilter = group ? { ...filter, status: { $in: group } } : filter;
  const total = group ? counts[query.status] : counts.all;
  const rows = await Intake.find(pageFilter)
    .select(LIST_FIELDS)
    .sort({ lastMessageAt: -1, _id: -1 })
    .skip((page - 1) * pageSize)
    .limit(pageSize);
  return {
    items: rows.map((row) => {
      const json = present(row);
      json.lineCount = row.proposal?.lines?.length || 0;
      json.overdue = ['needs_review', 'customer_confirmed'].includes(row.status) && row.reviewDueAt && row.reviewDueAt < new Date();
      delete json.proposal;
      return json;
    }),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    counts,
  };
}

async function getDraft(id) {
  const doc = await loadDraft(id);
  const json = present(doc);
  json.version = doc.__v;
  return json;
}

async function summary() {
  const now = new Date();
  const [needsReview, failed, waiting, overdue, oldest] = await Promise.all([
    Intake.countDocuments({ status: { $in: STATUS_GROUPS.review } }),
    Intake.countDocuments({ status: 'reading_failed' }),
    Intake.countDocuments({ status: { $in: STATUS_GROUPS.waiting } }),
    Intake.countDocuments({ status: { $in: STATUS_GROUPS.review }, reviewDueAt: { $lt: now } }),
    Intake.findOne({ status: { $in: STATUS_GROUPS.review } }).sort({ lastMessageAt: 1 }).select('lastMessageAt number'),
  ]);
  return {
    needsReview,
    failed,
    waiting,
    overdue,
    oldestWaitingSince: oldest?.lastMessageAt || null,
    oldestNumber: oldest?.number || '',
    today: businessYmd(now),
  };
}

async function getFile(id, fileId) {
  const doc = await loadDraft(id);
  const file = (doc.files || []).find((f) => String(f._id) === String(fileId));
  if (!file || !file.key) throw new ApiError(404, 'File not found');
  const buffer = await readStoredObject(file.key, file.storage || 'local').catch(() => null);
  if (!buffer) throw new ApiError(404, 'The file is no longer stored');
  return { buffer, originalName: file.originalName || 'file' };
}

async function matchInfo(id) {
  const doc = await loadDraft(id);
  const proposal = doc.proposal || { customer: {}, lines: [] };
  const customerMatch = doc.customer ? null : await matchCustomer(proposal, doc.sender);
  return {
    customerMatch,
    lineSuggestions: await suggestProducts(doc.customer, proposal.lines || []),
    routes: PRODUCTION_ROUTE_LIST.map((route) => ({ id: route.id, label: route.label, orderType: route.orderType })),
  };
}

// ---------------------------------------------------------------- review actions

function assertEditable(doc) {
  if (doc.status === 'converted') throw new ApiError(409, `This draft is already order ${doc.salesOrderNumber}`);
  if (doc.status === 'discarded') throw new ApiError(409, 'This draft was discarded. Restore it first.');
}

async function updateProposal(id, payload, user) {
  const doc = await loadDraft(id);
  assertEditable(doc);
  assertVersion(doc, payload?.version);
  const normalized = normalizeProposal(payload?.proposal || {}, []);
  normalized.warnings = doc.proposal?.warnings || [];
  doc.proposal = normalized;
  doc.markModified('proposal');
  doc.humanEdited = true;
  doc.newReadingAvailable = false;
  if (!doc.potentialOrder || ['stored', 'received', 'reading_failed'].includes(doc.status)) {
    doc.potentialOrder = true;
    doc.status = doc.customer ? 'customer_confirmed' : 'needs_review';
  }
  doc.error = '';
  doc.editedBy = userLabel(user);
  doc.editedAt = new Date();
  doc.history.push(historyEntry(user, 'edited'));
  await saveChecked(doc);
  if (doc.status === 'needs_review') await reviewTasks.ensureReviewTask(doc, (await getSettings()).reviewSlaHours);
  return getDraft(id);
}

async function useReading(id, readingId, payload, user) {
  const doc = await loadDraft(id);
  assertEditable(doc);
  assertVersion(doc, payload?.version);
  const reading = doc.readings.id(readingId);
  if (!reading?.proposal) throw new ApiError(404, 'Reading not found');
  doc.proposal = reading.proposal;
  doc.markModified('proposal');
  doc.warnings = reading.proposal.warnings || [];
  doc.humanEdited = false;
  doc.newReadingAvailable = false;
  for (const r of doc.readings) r.applied = String(r._id) === String(readingId);
  doc.history.push(historyEntry(user, 'used_reading', `Reading from ${reading.provider || 'the reader'}`));
  await saveChecked(doc);
  return getDraft(id);
}

async function reread(id, user) {
  const doc = await loadDraft(id);
  assertEditable(doc);
  if (!doc.potentialOrder) {
    doc.potentialOrder = true;
    doc.status = 'received';
  } else if (doc.status === 'reading_failed') {
    doc.status = 'received';
  }
  doc.error = '';
  doc.history.push(historyEntry(user, 'reread'));
  await saveChecked(doc);
  await scheduleRead(doc);
  return getDraft(id);
}

async function markNotOrder(id, payload, user) {
  const doc = await loadDraft(id);
  assertEditable(doc);
  assertVersion(doc, payload?.version);
  doc.potentialOrder = false;
  doc.status = 'stored';
  doc.error = '';
  doc.history.push(historyEntry(user, 'not_order'));
  await saveChecked(doc);
  await reviewTasks.closeReviewTask(doc, TASK_STATUSES.CANCELLED, user, 'Marked as not an order');
  return getDraft(id);
}

async function discard(id, payload, user) {
  const reason = String(payload?.reason || '').trim();
  if (!reason) throw new ApiError(400, 'Give a reason for discarding this draft');
  const doc = await loadDraft(id);
  assertEditable(doc);
  assertVersion(doc, payload?.version);
  doc.statusBeforeDiscard = doc.status;
  doc.status = 'discarded';
  doc.discardReason = reason.slice(0, 500);
  doc.openKey = undefined;
  doc.history.push(historyEntry(user, 'discarded', reason));
  await saveChecked(doc);
  await reviewTasks.closeReviewTask(doc, TASK_STATUSES.CANCELLED, user, `Draft discarded: ${reason}`);
  return getDraft(id);
}

async function restore(id, user) {
  const doc = await loadDraft(id);
  if (doc.status !== 'discarded') throw new ApiError(409, 'Only a discarded draft can be restored');
  const back = doc.statusBeforeDiscard && !['reading', 'converted', 'discarded'].includes(doc.statusBeforeDiscard) ? doc.statusBeforeDiscard : 'needs_review';
  doc.status = back;
  doc.discardReason = '';
  doc.history.push(historyEntry(user, 'restored'));
  await saveChecked(doc);
  if (['needs_review', 'customer_confirmed'].includes(doc.status)) {
    await reviewTasks.ensureReviewTask(doc, (await getSettings()).reviewSlaHours);
  }
  return getDraft(id);
}

// Step 1: the customer. Pick an existing one, or create one from the proposal.
async function confirmCustomer(id, payload, user) {
  const doc = await loadDraft(id);
  assertEditable(doc);
  assertVersion(doc, payload?.version);
  const customerService = require('../customer/customer.service');
  let customer;
  if (payload?.customerId) {
    customer = await customerService.getCustomer(payload.customerId);
    if (customer.isActive === false) throw new ApiError(400, 'That customer is inactive. Activate it first or pick another.');
  } else if (payload?.create && typeof payload.create === 'object') {
    if (!hasPermission(user, 'sales:create')) throw new ApiError(403, 'You cannot create customers');
    customer = await customerService.createCustomer({ ...payload.create, products: [] });
  } else {
    throw new ApiError(400, 'Choose a customer or create a new one');
  }
  doc.customer = customer.id;
  doc.customerName = customer.companyName || customer.name;
  doc.customerMatch = null;
  doc.potentialOrder = true;
  if (doc.status !== 'reading') doc.status = 'customer_confirmed';
  doc.history.push(historyEntry(user, 'customer_confirmed', `${customer.code} ${doc.customerName}`));
  await saveChecked(doc);
  return getDraft(id);
}

async function clearCustomer(id, payload, user) {
  const doc = await loadDraft(id);
  assertEditable(doc);
  assertVersion(doc, payload?.version);
  doc.customer = null;
  doc.customerName = '';
  if (doc.status === 'customer_confirmed') doc.status = 'needs_review';
  doc.customerMatch = await matchCustomer(doc.proposal || {}, doc.sender);
  doc.history.push(historyEntry(user, 'customer_cleared'));
  await saveChecked(doc);
  return getDraft(id);
}

// ---------------------------------------------------------------- convert

const COPY_FIELDS = ['product', 'productCode', 'productType', 'size', 'material', 'thickness', 'width', 'length', 'color', 'unit', 'taxPercent', 'hsnCode', 'manufacturing', 'roll', 'bag', 'printing', 'holes', 'tape', 'image', 'images', 'productionRoute'];

async function baseSpec(line, customerId) {
  if (line.source === 'customer' && line.sourceId) {
    const Customer = require('../customer/customer.model');
    const customer = await Customer.findById(customerId).select('products').lean();
    const product = (customer?.products || []).find((p) => String(p._id) === String(line.sourceId));
    if (product) return { spec: product, templateId: '' };
  }
  if (line.source === 'template' && mongoose.isValidObjectId(line.sourceId)) {
    const template = await require('../salesSettings/template.model').findById(line.sourceId).lean();
    if (template) return { spec: { ...template, product: template.product || template.name, productCode: template.productCode || template.code }, templateId: String(template._id) };
  }
  return { spec: {}, templateId: '' };
}

function textOr(value, fallback) {
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || fallback || '';
}

async function buildItems(lines, customerId) {
  const items = [];
  for (const line of lines) {
    if (line.include === false) continue;
    const { spec, templateId } = await baseSpec(line, customerId);
    const item = {};
    for (const field of COPY_FIELDS) if (spec[field] !== undefined) item[field] = spec[field];
    item.templateId = templateId;
    item.product = textOr(line.product, item.product);
    item.material = textOr(line.material, item.material);
    item.width = textOr(line.width, item.width);
    item.length = textOr(line.length, item.length);
    item.unit = textOr(line.unit, item.unit) || 'pcs';
    item.productionRoute = textOr(line.productionRoute, item.productionRoute);
    item.quantity = Number(line.quantity) || 0;
    item.rate = line.rate === null || line.rate === undefined || line.rate === '' ? Number(spec.rate) || 0 : Number(line.rate) || 0;
    item.taxPercent = item.taxPercent ?? 18;
    if (line.notes) {
      item.manufacturing = { ...item.manufacturing };
      item.manufacturing.specialRequirements = [item.manufacturing.specialRequirements, String(line.notes).trim()].filter(Boolean).join('. ');
    }
    if (!item.productionRoute) throw new ApiError(400, `Choose a production route for ${item.product || 'each line'}`);
    items.push(item);
  }
  if (!items.length) throw new ApiError(400, 'Include at least one line');
  return items;
}

function deliveryDateFrom(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return text >= businessYmd() ? text : null;
}

// Step 2: turn the reviewed lines into a DRAFT sales order. Never submits it.
async function convert(id, payload, user) {
  const doc = await loadDraft(id);
  assertEditable(doc);
  assertVersion(doc, payload?.version);
  if (!doc.customer) throw new ApiError(400, 'Confirm the customer first');
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  const items = await buildItems(lines, doc.customer);

  // Only one convert at a time: two clicks must not make two orders.
  const locked = await Intake.findOneAndUpdate(
    { _id: doc._id, status: { $nin: ['converted', 'discarded'] }, $or: [{ convertingAt: null }, { convertingAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) } }] },
    { $set: { convertingAt: new Date() } }
  );
  if (!locked) throw new ApiError(409, 'This draft is already being converted');

  const salesOrderService = require('../salesOrder/salesOrder.service');
  let order;
  try {
    const proposal = doc.proposal || {};
    order = await salesOrderService.createOrder(
      user,
      {
        customerId: String(doc.customer),
        orderType: payload.orderType === 'job_work' ? 'job_work' : 'sales_order',
        deliveryDate: payload.deliveryDate !== undefined ? payload.deliveryDate || null : deliveryDateFrom(proposal.deliveryDate),
        billingAddress: proposal.customer?.billingAddress || '',
        shippingAddress: proposal.customer?.shippingAddress || '',
        remarks: [`From draft order ${doc.number} (${doc.channel})`, String(payload.remarks ?? proposal.notes ?? '').trim()].filter(Boolean).join('. '),
        items,
      },
      { source: { intakeId: doc._id, intakeNumber: doc.number }, rememberProducts: false }
    );
  } catch (error) {
    await Intake.updateOne({ _id: doc._id }, { $set: { convertingAt: null } });
    throw error;
  }

  // The customer's files go on the order as purchase-order attachments.
  const warnings = [];
  for (const file of doc.files || []) {
    try {
      const buffer = await readStoredObject(file.key, file.storage || 'local');
      if (!buffer?.length) continue;
      await salesOrderService.addAttachment(user, order.id, { buffer, originalname: file.originalName, mimetype: file.mimeType }, 'po');
    } catch (error) {
      warnings.push(`${file.originalName}: ${error.message}`);
    }
  }

  await Intake.updateOne(
    { _id: doc._id },
    {
      $set: { status: 'converted', salesOrder: order.id, salesOrderNumber: order.number, convertingAt: null },
      $unset: { openKey: 1 },
      $push: { history: historyEntry(user, 'converted', `Draft sales order ${order.number}${warnings.length ? `. Files not copied: ${warnings.join('; ')}` : ''}`) },
      $inc: { __v: 1 },
    }
  );
  await reviewTasks.closeReviewTask(doc, TASK_STATUSES.DONE, user, `Converted to ${order.number}`);
  return { draft: await getDraft(id), order: { id: order.id, number: order.number }, warnings };
}

// ---------------------------------------------------------------- settings / housekeeping

async function settingsView() {
  const { presentSettings } = require('./intake.settings');
  const usage = await require('./ai').usageSummary(30);
  return { ...presentSettings(await getSettings()), usage };
}

async function updateSettings(payload) {
  const { presentSettings, saveSettings } = require('./intake.settings');
  return presentSettings(await saveSettings(payload));
}

// Non-order mail keeps only who/when/subject after the retention period.
async function removeOldBodies() {
  const settings = await getSettings();
  const cutoff = new Date(Date.now() - (settings.retentionDays || 30) * 24 * 60 * 60 * 1000);
  const old = await Intake.find({ status: 'stored', lastMessageAt: { $lt: cutoff }, bodyRemovedAt: null }).limit(200);
  for (const doc of old) {
    for (const file of doc.files || []) await deleteStoredObject(file.key, file.storage || 'local').catch(() => {});
    await Intake.updateOne(
      { _id: doc._id, status: 'stored' },
      {
        $set: {
          rawBody: '',
          files: [],
          proposal: null,
          readings: [],
          'messages.$[].body': '',
          'messages.$[].fileIds': [],
          bodyRemovedAt: new Date(),
        },
        $unset: { openKey: 1 },
      }
    );
  }
  return old.length;
}

// After a restart: drafts left mid-read are queued again.
async function recoverStuck() {
  const stuck = await Intake.find({ status: { $in: ['received', 'reading'] }, potentialOrder: true }).select('_id status potentialOrder').limit(500);
  for (const doc of stuck) await scheduleRead(doc);
  return stuck.length;
}

module.exports = {
  ingestMessage,
  scheduleRead,
  runRead,
  scheduleReply,
  createPanelDraft,
  readPanelDraft,
  listDrafts,
  getDraft,
  summary,
  getFile,
  matchInfo,
  updateProposal,
  useReading,
  reread,
  markNotOrder,
  discard,
  restore,
  confirmCustomer,
  clearCustomer,
  convert,
  settingsView,
  updateSettings,
  removeOldBodies,
  recoverStuck,
};
