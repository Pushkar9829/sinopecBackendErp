const { body, param, query } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const productionController = require('./production.controller');

const { FLOOR_STAGES } = require('./production.flow');

const router = express.Router();
const FLOOR_STAGE_IDS = FLOOR_STAGES.map((item) => item.id);

const VIEW_KEYS = [
  'production:read',
  'production:rolling:read',
  'production:printing:read',
  'production:cutting:read',
  'dispatch:read',
];

const WORK_KEYS = [
  'production:update',
  'production:rolling:update',
  'production:printing:update',
  'production:cutting:update',
  'dispatch:update',
];

router.get(
  '/queue',
  authenticate,
  authorize.any(...VIEW_KEYS),
  validate([query('stage').optional().isIn(FLOOR_STAGE_IDS)]),
  productionController.listQueue
);

router.get(
  '/machines/:stage',
  authenticate,
  authorize.any(...VIEW_KEYS),
  validate([param('stage').isIn(FLOOR_STAGE_IDS)]),
  productionController.stageMachines
);

router.post(
  '/pickup',
  authenticate,
  authorize.any(...WORK_KEYS),
  validate([
    body('orderId').isMongoId().withMessage('Invalid sales order'),
    body('itemId').isMongoId().withMessage('Invalid line item'),
    body('stage').isIn(FLOOR_STAGE_IDS).withMessage('Unknown stage'),
    body('lotId').isMongoId().withMessage('Pick an inventory lot'),
    body('qty').isFloat({ gt: 0 }).withMessage('Enter how much to pick'),
    body('vehicleNumber').optional().isString(),
    body('handoverPerson').optional().isString(),
    body('deliveryPartner').optional().isString(),
    body('shift').optional().isString(),
    body('workDate').optional().isString(),
    body('notes').optional().isString(),
  ]),
  productionController.pickupLot
);

router.post(
  '/release',
  authenticate,
  authorize.any(...WORK_KEYS),
  validate([
    body('orderId').isMongoId().withMessage('Invalid sales order'),
    body('itemId').isMongoId().withMessage('Invalid line item'),
    body('stage').isIn(FLOOR_STAGE_IDS).withMessage('Unknown stage'),
  ]),
  productionController.releasePickup
);

router.post(
  '/complete',
  authenticate,
  authorize.any(...WORK_KEYS),
  validate([
    body('orderId').isMongoId().withMessage('Invalid sales order'),
    body('itemId').isMongoId().withMessage('Invalid line item'),
    body('stage').isIn(FLOOR_STAGE_IDS).withMessage('Unknown stage'),
    body('machineId').optional({ nullable: true, checkFalsy: true }).isMongoId(),
    body('inputQty').optional().isFloat({ min: 0 }),
    body('outputQty').optional().isFloat({ min: 0 }),
    body('wasteQty').optional().isFloat({ min: 0 }),
    body('shift').optional().isIn(['morning', 'afternoon', 'night']),
    body('workDate').optional().isISO8601().withMessage('Invalid work date'),
    body('notes').optional().isString(),
    body('vehicleNumber').optional().isString(),
    body('handoverPerson').optional().isString(),
    body('deliveryPartner').optional().isString(),
  ]),
  productionController.completeStage
);

module.exports = router;
