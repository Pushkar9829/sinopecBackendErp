const asyncHandler = require('../../utils/asyncHandler');
const salesSettingsService = require('./salesSettings.service');

const listOptions = asyncHandler(async (req, res) => {
  const data = await salesSettingsService.listOptions(req.query.group);
  res.json({ success: true, data });
});

const createOption = asyncHandler(async (req, res) => {
  const option = await salesSettingsService.createOption(req.body);
  res.status(201).json({ success: true, data: option });
});

const updateOption = asyncHandler(async (req, res) => {
  const option = await salesSettingsService.updateOption(req.params.id, req.body);
  res.json({ success: true, data: option });
});

const removeOption = asyncHandler(async (req, res) => {
  await salesSettingsService.deleteOption(req.params.id);
  res.json({ success: true, message: 'Option deleted' });
});

const listTemplates = asyncHandler(async (req, res) => {
  const templates = await salesSettingsService.listTemplates();
  res.json({ success: true, data: templates });
});

const getTemplate = asyncHandler(async (req, res) => {
  const template = await salesSettingsService.getTemplate(req.params.id);
  res.json({ success: true, data: template });
});

const createTemplate = asyncHandler(async (req, res) => {
  const template = await salesSettingsService.createTemplate(req.body);
  res.status(201).json({ success: true, data: template });
});

const updateTemplate = asyncHandler(async (req, res) => {
  const template = await salesSettingsService.updateTemplate(req.params.id, req.body);
  res.json({ success: true, data: template });
});

const removeTemplate = asyncHandler(async (req, res) => {
  await salesSettingsService.deleteTemplate(req.params.id);
  res.json({ success: true, message: 'Template deleted' });
});

module.exports = {
  listOptions,
  createOption,
  updateOption,
  removeOption,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  removeTemplate,
};
