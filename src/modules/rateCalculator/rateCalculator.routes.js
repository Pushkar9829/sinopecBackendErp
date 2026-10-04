const { body } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const rateCalculatorController = require('./rateCalculator.controller');

const router = express.Router();
const canRead = authorize.any('sales:read');
const isObject = body().custom((value) => value && typeof value === 'object' && !Array.isArray(value)).withMessage('Send the values as an object');

router.get('/defaults', authenticate, canRead, rateCalculatorController.defaults);
router.post('/job-work', authenticate, canRead, validate([isObject]), rateCalculatorController.jobWork);
router.post('/sales-order', authenticate, canRead, validate([isObject]), rateCalculatorController.salesOrder);
router.post(
  '/rolling',
  authenticate,
  authorize.any('sales:read', 'sales:create', 'sales:update'),
  validate([isObject]),
  rateCalculatorController.rolling
);

module.exports = router;
