const { param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { SALES_ORDER_VIEW_KEYS } = require('../../config/constants');
const { FLOOR_STAGES } = require('../production/production.flow');
const registerController = require('./register.controller');

const router = express.Router();
const STAGE_IDS = FLOOR_STAGES.map((item) => item.id);

const VIEW_KEYS = [
  ...SALES_ORDER_VIEW_KEYS,
  'production:rolling:read',
  'production:printing:read',
  'production:cutting:read',
  'dispatch:read',
];

router.get('/', authenticate, authorize.any(...VIEW_KEYS), registerController.list);

router.get(
  '/stage/:stage',
  authenticate,
  authorize.any(...VIEW_KEYS),
  validate([param('stage').isIn(STAGE_IDS)]),
  registerController.getStage
);

router.get(
  '/order/:orderId',
  authenticate,
  authorize.any(...VIEW_KEYS),
  validate([param('orderId').isMongoId().withMessage('Invalid order')]),
  registerController.getByOrder
);

module.exports = router;
