const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const intakeService = require('./intake.service');
const whatsapp = require('./intake.whatsapp');
const gmail = require('./intake.gmail');
const { getSettings } = require('./intake.settings');

const list = asyncHandler(async (_req, res) => {
  const drafts = await intakeService.listDrafts();
  res.json({ success: true, data: drafts });
});

const getOne = asyncHandler(async (req, res) => {
  const draft = await intakeService.getDraft(req.params.id);
  res.json({ success: true, data: draft });
});

const getSettingsView = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: await intakeService.settingsView() });
});

const saveSettingsView = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await intakeService.updateSettings(req.body || {}) });
});

const paste = asyncHandler(async (req, res) => {
  const draft = await intakeService.pasteDraft(req.body?.text);
  res.status(201).json({ success: true, data: draft });
});

const reread = asyncHandler(async (req, res) => {
  const draft = await intakeService.rereadDraft(req.params.id);
  res.json({ success: true, data: draft });
});

const discard = asyncHandler(async (req, res) => {
  const draft = await intakeService.discardDraft(req.params.id);
  res.json({ success: true, data: draft });
});

const whatsappWebhook = asyncHandler(async (req, res) => {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const settings = await getSettings();
    if (mode === 'subscribe' && token && settings.whatsappVerifyToken && token === settings.whatsappVerifyToken) {
      return res.status(200).send(String(challenge || ''));
    }
    throw new ApiError(403, 'WhatsApp verification failed');
  }

  const ok = await whatsapp.verifyWebhook(req);
  if (!ok) throw new ApiError(401, 'WhatsApp signature was rejected');
  await whatsapp.ingestPayload(req.body || {});
  return res.sendStatus(200);
});

const gmailStart = asyncHandler(async (_req, res) => {
  const url = await gmail.startUrl();
  res.json({ success: true, data: { url } });
});

const gmailCallback = asyncHandler(async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    await gmail.finishCallback(String(req.query.code || ''), String(req.query.state || ''));
    return res.redirect(gmail.frontendRedirect('gmail=connected'));
  } catch (error) {
    const message = encodeURIComponent(error.message || 'Gmail connection failed');
    return res.redirect(gmail.frontendRedirect(`gmail=error&message=${message}`));
  }
});

module.exports = {
  list,
  getOne,
  getSettingsView,
  saveSettingsView,
  paste,
  reread,
  discard,
  whatsappWebhook,
  gmailStart,
  gmailCallback,
};
