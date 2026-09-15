const { SALES_OPTION_GROUPS } = require('../../config/constants');
const ApiError = require('../../utils/ApiError');
const { normalizeItem } = require('../salesOrder/salesOrder.service');
const repo = require('./salesSettings.repo');

const GROUP_IDS = SALES_OPTION_GROUPS.map((group) => group.id);

function toPublicOption(option) {
  return {
    id: String(option._id),
    group: option.group,
    value: option.value,
    isActive: option.isActive !== false,
  };
}

function toPublicTemplate(template) {
  const spec = normalizeItem(template);
  return {
    id: String(template._id),
    name: template.name,
    code: template.code || '',
    isActive: template.isActive !== false,
    ...spec,
    id: String(template._id),
  };
}

function optionsByGroup(options) {
  const grouped = Object.fromEntries(GROUP_IDS.map((id) => [id, []]));
  for (const option of options) {
    if (option.isActive === false) continue;
    if (!grouped[option.group]) grouped[option.group] = [];
    grouped[option.group].push(option.value);
  }
  return grouped;
}

async function listOptions(group) {
  const filter = {};
  if (group) {
    if (!GROUP_IDS.includes(group)) throw new ApiError(400, 'Unknown option group');
    filter.group = group;
  }
  const options = await repo.findOptions(filter);
  return {
    groups: SALES_OPTION_GROUPS,
    options: options.map(toPublicOption),
    byGroup: optionsByGroup(options),
  };
}

async function createOption(payload) {
  const group = String(payload.group || '').trim();
  const value = String(payload.value || '').trim();
  if (!GROUP_IDS.includes(group)) throw new ApiError(400, 'Unknown option group');
  if (!value) throw new ApiError(400, 'Value is required');
  const existing = await repo.findOptionByGroupValue(group, value);
  if (existing) throw new ApiError(409, 'That value is already in the list');
  return toPublicOption(await repo.createOption({ group, value, isActive: true }));
}

async function updateOption(id, payload) {
  const option = await repo.findOption(id);
  if (!option) throw new ApiError(404, 'Option not found');
  const data = {};
  if (payload.value !== undefined) {
    const value = String(payload.value || '').trim();
    if (!value) throw new ApiError(400, 'Value is required');
    const existing = await repo.findOptionByGroupValue(option.group, value);
    if (existing && String(existing._id) !== String(option._id)) {
      throw new ApiError(409, 'That value is already in the list');
    }
    data.value = value;
  }
  if (payload.isActive !== undefined) data.isActive = Boolean(payload.isActive);
  return toPublicOption(await repo.updateOption(id, data));
}

async function deleteOption(id) {
  const option = await repo.findOption(id);
  if (!option) throw new ApiError(404, 'Option not found');
  await repo.deleteOption(id);
}

async function listTemplates() {
  const templates = await repo.findTemplates();
  return templates.map(toPublicTemplate);
}

async function getTemplate(id) {
  const template = await repo.findTemplate(id);
  if (!template) throw new ApiError(404, 'Template not found');
  return toPublicTemplate(template);
}

function templatePayload(payload) {
  const name = String(payload.name || '').trim();
  if (!name) throw new ApiError(400, 'Template name is required');
  const spec = normalizeItem(payload);
  delete spec._id;
  return {
    name,
    code: String(payload.code || spec.productCode || '').trim(),
    isActive: payload.isActive !== false,
    ...spec,
  };
}

async function createTemplate(payload) {
  return toPublicTemplate(await repo.createTemplate(templatePayload(payload)));
}

async function updateTemplate(id, payload) {
  const template = await repo.findTemplate(id);
  if (!template) throw new ApiError(404, 'Template not found');
  return toPublicTemplate(await repo.updateTemplate(id, templatePayload({ ...template.toObject(), ...payload })));
}

async function deleteTemplate(id) {
  const template = await repo.findTemplate(id);
  if (!template) throw new ApiError(404, 'Template not found');
  await repo.deleteTemplate(id);
}

module.exports = {
  listOptions,
  createOption,
  updateOption,
  deleteOption,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
};
