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
  // Quantity, discount and tax belong to each order line, not to the saved product.
  const spec = normalizeItem({ ...payload, quantity: 0, discount: 0, taxPercent: 0 });
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

const OPTION_FIELDS = [
  ['productType', 'productType'],
  ['material', 'material'],
  ['unit', 'unit'],
  ['color', 'color'],
  ['thickness', 'thickness'],
  ['width', 'width'],
  ['length', 'length'],
  ['manufacturing.materialType', 'materialType'],
  ['manufacturing.materialGrade', 'materialGrade'],
  ['manufacturing.additives', 'additive'],
  ['manufacturing.specialRequirements', 'specialRequirement'],
  ['roll.width', 'width'],
  ['roll.length', 'length'],
  ['holes.count', 'holeCount'],
  ['holes.type', 'holeType'],
  ['holes.size', 'holeSize'],
  ['holes.position', 'holePosition'],
  ['tape.type', 'tapeType'],
  ['printing.impressions', 'printImpression'],
  ['printing.colors', 'printColor'],
  ['printing.design', 'printDesign'],
];

function readPath(source, path) {
  return path.split('.').reduce((current, key) => (current == null ? undefined : current[key]), source);
}

async function rememberNewOptions(items) {
  const options = await repo.findOptions();
  const known = new Set(options.map((option) => `${option.group}::${String(option.value || '').trim().toLowerCase()}`));

  for (const item of items) {
    for (const [path, group] of OPTION_FIELDS) {
      const value = String(readPath(item, path) || '').trim();
      if (!value || value.length > 80) continue;
      const key = `${group}::${value.toLowerCase()}`;
      if (known.has(key)) continue;
      known.add(key);
      await repo.createOption({ group, value, isActive: true }).catch((error) => {
        if (error?.code !== 11000) throw error;
      });
    }
  }
}

async function ensureTemplatesFromItems(rawItems = [], items = []) {
  const templates = await repo.findTemplates();
  const byId = new Map(templates.map((template) => [String(template._id), template]));
  const names = new Set(
    templates.map((template) => String(template.product || template.name || '').trim().toLowerCase()).filter(Boolean)
  );
  const codes = new Set(
    templates.map((template) => String(template.code || template.productCode || '').trim().toLowerCase()).filter(Boolean)
  );

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const name = String(item?.product || '').trim();
    if (!name) continue;

    const templateId = String(item.templateId || '').trim();
    const linked = templateId ? byId.get(templateId) : null;
    const linkedName = String(linked?.product || linked?.name || '').trim().toLowerCase();
    if (linked && linkedName === name.toLowerCase()) continue;
    if (names.has(name.toLowerCase())) continue;

    const code = String(item.productCode || '').trim().toLowerCase();
    if (code && codes.has(code)) continue;

    const spec = { ...item };
    delete spec._id;
    delete spec.id;
    delete spec.currentStage;
    delete spec.stageWork;
    delete spec.amount;
    const created = await repo.createTemplate(
      templatePayload({
        ...spec,
        name,
        code: item.productCode || '',
        product: name,
        isActive: true,
      })
    );
    names.add(name.toLowerCase());
    if (code) codes.add(code);
    byId.set(String(created._id), created);
  }

  await rememberNewOptions(items);
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
  ensureTemplatesFromItems,
};
