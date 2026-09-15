const SalesOption = require('./option.model');
const ProductTemplate = require('./template.model');

function findOptions(filter = {}) {
  return SalesOption.find(filter).sort({ group: 1, value: 1 });
}

function findOption(id) {
  return SalesOption.findById(id);
}

function findOptionByGroupValue(group, value) {
  return SalesOption.findOne({ group, value });
}

function createOption(data) {
  return SalesOption.create(data);
}

function updateOption(id, data) {
  return SalesOption.findByIdAndUpdate(id, { $set: data }, { new: true });
}

function deleteOption(id) {
  return SalesOption.findByIdAndDelete(id);
}

function countOptions() {
  return SalesOption.countDocuments();
}

function findTemplates(filter = {}) {
  return ProductTemplate.find(filter).sort({ name: 1 });
}

function findTemplate(id) {
  return ProductTemplate.findById(id);
}

function createTemplate(data) {
  return ProductTemplate.create(data);
}

function updateTemplate(id, data) {
  return ProductTemplate.findByIdAndUpdate(id, { $set: data }, { new: true });
}

function deleteTemplate(id) {
  return ProductTemplate.findByIdAndDelete(id);
}

function countTemplates() {
  return ProductTemplate.countDocuments();
}

module.exports = {
  findOptions,
  findOption,
  findOptionByGroupValue,
  createOption,
  updateOption,
  deleteOption,
  countOptions,
  findTemplates,
  findTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  countTemplates,
};
