const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const { sendStoredFile } = require('../../utils/storage');
const intakeService = require('./intake.service');
const whatsapp = require('./intake.whatsapp');
const gmail = require('./intake.gmail');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

const list = asyncHandler(async (req, res) => ok(res, await intakeService.listDrafts(req.query)));
const summary = asyncHandler(async (_req, res) => ok(res, await intakeService.summary()));
const getOne = asyncHandler(async (req, res) => ok(res, await intakeService.getDraft(req.params.id)));
const match = asyncHandler(async (req, res) => ok(res, await intakeService.matchInfo(req.params.id)));
const products = asyncHandler(async (req, res) => ok(res, await intakeService.productsFor(req.params.id, req.query)));
const customers = asyncHandler(async (req, res) => ok(res, await intakeService.findCustomers(req.query)));
const file = asyncHandler(async (req, res) => sendStoredFile(res, await intakeService.getFile(req.params.id, req.params.fileId)));

const getSettingsView = asyncHandler(async (_req, res) => ok(res, await intakeService.settingsView()));
const saveSettingsView = asyncHandler(async (req, res) => ok(res, await intakeService.updateSettings(req.body || {})));

const createPanel = asyncHandler(async (req, res) => ok(res, await intakeService.createPanelDraft(req.body || {}, req.user), 201));
const readPanel = asyncHandler(async (req, res) => {
  const sender = { name: req.body?.senderName, phone: req.body?.senderPhone, email: req.body?.senderEmail };
  ok(res, await intakeService.readPanelDraft({ text: req.body?.text, sender }, req.files || [], req.user), 201);
});

const saveProposal = asyncHandler(async (req, res) => ok(res, await intakeService.updateProposal(req.params.id, req.body || {}, req.user)));
const useReading = asyncHandler(async (req, res) =>
  ok(res, await intakeService.useReading(req.params.id, req.params.readingId, req.body || {}, req.user))
);
const reread = asyncHandler(async (req, res) => ok(res, await intakeService.reread(req.params.id, req.user)));
const markNotOrder = asyncHandler(async (req, res) => ok(res, await intakeService.markNotOrder(req.params.id, req.body || {}, req.user)));
const discard = asyncHandler(async (req, res) => ok(res, await intakeService.discard(req.params.id, req.body || {}, req.user)));
const restore = asyncHandler(async (req, res) => ok(res, await intakeService.restore(req.params.id, req.user)));
const confirmCustomer = asyncHandler(async (req, res) =>
  ok(res, await intakeService.confirmCustomer(req.params.id, req.body || {}, req.user))
);
const clearCustomer = asyncHandler(async (req, res) => ok(res, await intakeService.clearCustomer(req.params.id, req.body || {}, req.user)));
const convert = asyncHandler(async (req, res) => ok(res, await intakeService.convert(req.params.id, req.body || {}, req.user), 201));

const whatsappVerify = asyncHandler(async (req, res) => {
  if (!(await whatsapp.verifySubscription(req.query))) throw new ApiError(403, 'WhatsApp verification failed');
  res.status(200).type('text/plain').send(String(req.query['hub.challenge'] || ''));
});

const whatsappWebhook = asyncHandler(async (req, res) => {
  if (!(await whatsapp.verifyWebhook(req))) throw new ApiError(401, 'WhatsApp signature was rejected');
  await whatsapp.acceptPayload(req.body || {});
  res.sendStatus(200);
});

const gmailStart = asyncHandler(async (req, res) => {
  try {
    ok(res, { url: await gmail.startUrl(req.user) });
  } catch (error) {
    throw new ApiError(400, error.message);
  }
});

const gmailDisconnect = asyncHandler(async (_req, res) => {
  await gmail.disconnect();
  ok(res, await intakeService.settingsView());
});

const gmailCallback = asyncHandler(async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error));
    await gmail.finishCallback(String(req.query.code || ''), String(req.query.state || ''), gmail.sessionUserId(req));
    return res.redirect(gmail.frontendRedirect('gmail=connected'));
  } catch (error) {
    const message = encodeURIComponent(error.message || 'Gmail connection failed');
    return res.redirect(gmail.frontendRedirect(`gmail=error&message=${message}`));
  }
});

module.exports = {
  list,
  summary,
  getOne,
  match,
  products,
  customers,
  file,
  getSettingsView,
  saveSettingsView,
  createPanel,
  readPanel,
  saveProposal,
  useReading,
  reread,
  markNotOrder,
  discard,
  restore,
  confirmCustomer,
  clearCustomer,
  convert,
  whatsappVerify,
  whatsappWebhook,
  gmailStart,
  gmailDisconnect,
  gmailCallback,
};
