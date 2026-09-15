const { body, param, query } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { SALES_OPTION_GROUPS } = require('../../config/constants');
const salesSettingsController = require('./salesSettings.controller');

const router = express.Router();
const idParam = param('id').isMongoId().withMessage('Invalid id');
const groupIds = SALES_OPTION_GROUPS.map((group) => group.id);

router.get(
  '/options',
  authenticate,
  authorize('sales:read'),
  validate([query('group').optional().isIn(groupIds).withMessage('Unknown option group')]),
  salesSettingsController.listOptions
);
router.post(
  '/options',
  authenticate,
  authorize('sales:update'),
  validate([
    body('group').isIn(groupIds).withMessage('Unknown option group'),
    body('value').trim().notEmpty().withMessage('Value is required'),
  ]),
  salesSettingsController.createOption
);
router.patch(
  '/options/:id',
  authenticate,
  authorize('sales:update'),
  validate([
    idParam,
    body('value').optional().trim().notEmpty().withMessage('Value is required'),
    body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  ]),
  salesSettingsController.updateOption
);
router.delete(
  '/options/:id',
  authenticate,
  authorize('sales:update'),
  validate([idParam]),
  salesSettingsController.removeOption
);

router.get('/templates', authenticate, authorize('sales:read'), salesSettingsController.listTemplates);
router.get('/templates/:id', authenticate, authorize('sales:read'), validate([idParam]), salesSettingsController.getTemplate);
router.post(
  '/templates',
  authenticate,
  authorize('sales:create'),
  validate([body('name').trim().notEmpty().withMessage('Template name is required')]),
  salesSettingsController.createTemplate
);
router.patch(
  '/templates/:id',
  authenticate,
  authorize('sales:update'),
  validate([idParam, body('name').optional().trim().notEmpty().withMessage('Template name cannot be empty')]),
  salesSettingsController.updateTemplate
);
router.delete(
  '/templates/:id',
  authenticate,
  authorize('sales:delete'),
  validate([idParam]),
  salesSettingsController.removeTemplate
);

module.exports = router;
