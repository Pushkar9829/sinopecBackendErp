const asyncHandler = require('../../utils/asyncHandler');
const rateCalculatorService = require('./rateCalculator.service');

const defaults = asyncHandler(async (req, res) => {
  res.json({ success: true, data: rateCalculatorService.defaults() });
});

const jobWork = asyncHandler(async (req, res) => {
  res.json({ success: true, data: rateCalculatorService.jobWork(req.body) });
});

const salesOrder = asyncHandler(async (req, res) => {
  res.json({ success: true, data: rateCalculatorService.salesOrder(req.body) });
});

const rolling = asyncHandler(async (req, res) => {
  res.json({ success: true, data: rateCalculatorService.rolling(req.body) });
});

module.exports = {
  defaults,
  jobWork,
  salesOrder,
  rolling,
};
