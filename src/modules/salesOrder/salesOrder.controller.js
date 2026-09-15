const fs = require('fs/promises');
const asyncHandler = require('../../utils/asyncHandler');
const salesOrderService = require('./salesOrder.service');

const list = asyncHandler(async (req, res) => {
  const orders = await salesOrderService.listOrders(req.user);
  res.json({ success: true, data: orders });
});

const summary = asyncHandler(async (req, res) => {
  const data = await salesOrderService.getSummary(req.user);
  res.json({ success: true, data });
});

const meta = asyncHandler(async (req, res) => {
  res.json({ success: true, data: salesOrderService.getMeta() });
});

const getOne = asyncHandler(async (req, res) => {
  const order = await salesOrderService.getOrder(req.user, req.params.id);
  res.json({ success: true, data: order });
});

const create = asyncHandler(async (req, res) => {
  const order = await salesOrderService.createOrder(req.user, req.body);
  res.status(201).json({ success: true, data: order });
});

const update = asyncHandler(async (req, res) => {
  const order = await salesOrderService.updateOrder(req.user, req.params.id, req.body);
  res.json({ success: true, data: order });
});

const remove = asyncHandler(async (req, res) => {
  await salesOrderService.deleteOrder(req.params.id);
  res.json({ success: true, message: 'Sales order deleted' });
});

const submit = asyncHandler(async (req, res) => {
  const order = await salesOrderService.submitOrder(req.user, req.params.id);
  res.json({ success: true, data: order });
});

const approve = asyncHandler(async (req, res) => {
  const order = await salesOrderService.approveOrder(req.user, req.params.id);
  res.json({ success: true, data: order });
});

const planProduction = asyncHandler(async (req, res) => {
  const order = await salesOrderService.planProduction(req.user, req.params.id);
  res.json({ success: true, data: order });
});

const advance = asyncHandler(async (req, res) => {
  const order = await salesOrderService.advanceOrder(req.user, req.params.id);
  res.json({ success: true, data: order });
});

const cancel = asyncHandler(async (req, res) => {
  const order = await salesOrderService.cancelOrder(req.user, req.params.id, req.body?.reason);
  res.json({ success: true, data: order });
});

const addAttachment = asyncHandler(async (req, res) => {
  try {
    const order = await salesOrderService.addAttachment(req.user, req.params.id, req.file, req.body.kind);
    res.status(201).json({ success: true, data: order });
  } catch (err) {
    if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
    throw err;
  }
});

const removeAttachment = asyncHandler(async (req, res) => {
  const order = await salesOrderService.removeAttachment(req.user, req.params.id, req.params.attachmentId);
  res.json({ success: true, data: order });
});

const downloadAttachment = asyncHandler(async (req, res) => {
  const { filePath, originalName } = await salesOrderService.getAttachmentFile(
    req.params.id,
    req.params.attachmentId
  );
  res.download(filePath, originalName);
});

module.exports = {
  list,
  summary,
  meta,
  getOne,
  create,
  update,
  remove,
  submit,
  approve,
  planProduction,
  advance,
  cancel,
  addAttachment,
  removeAttachment,
  downloadAttachment,
};
