const { query } = require('express-validator');
const express = require('express');
const { ANALYTICS_VIEW_KEYS } = require('../../config/constants');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const analyticsController = require('./analytics.controller');

const router = express.Router();

router.get(
  '/',
  authenticate,
  authorize.any(...ANALYTICS_VIEW_KEYS),
  validate([
    query('from').optional().isISO8601().withMessage('Invalid from date'),
    query('to').optional().isISO8601().withMessage('Invalid to date'),
    query('stage').optional().isIn(['rolling', 'printing', 'cutting', 'dispatch', 'delivery', 'all', '']),
  ]),
  analyticsController.getAnalytics
);

module.exports = router;
