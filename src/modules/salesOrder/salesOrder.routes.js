const { body, param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const upload = require('../../middlewares/upload');
const validate = require('../../middlewares/validate');
const { SALES_ORDER_VIEW_KEYS } = require('../../config/constants');
const salesOrderController = require('./salesOrder.controller');

const router = express.Router();
const idParam = param('id').isMongoId().withMessage('Invalid id');
const attachmentParam = param('attachmentId').isMongoId().withMessage('Invalid attachment id');
const canView = authorize.any(...SALES_ORDER_VIEW_KEYS);

router.get('/', authenticate, canView, salesOrderController.list);
router.get('/summary', authenticate, canView, salesOrderController.summary);
router.get('/meta', authenticate, canView, salesOrderController.meta);
const canViewOne = authorize.any(
  ...SALES_ORDER_VIEW_KEYS,
  'production:rolling:read',
  'production:printing:read',
  'production:cutting:read',
  'dispatch:read'
);

router.get('/:id', authenticate, canViewOne, validate([idParam]), salesOrderController.getOne);
router.post(
  '/',
  authenticate,
  authorize('sales:create'),
  validate([
    body('orderType').optional().isIn(['sales_order', 'job_work']).withMessage('Order type must be Sales order or Job work'),
    body('customerId').isMongoId().withMessage('Customer is required'),
    body('items').isArray({ min: 1 }).withMessage('Add at least one product'),
  ]),
  salesOrderController.create
);
router.patch(
  '/:id',
  authenticate,
  authorize('sales:update'),
  validate([idParam]),
  salesOrderController.update
);
router.delete(
  '/:id',
  authenticate,
  authorize('sales:delete'),
  validate([idParam]),
  salesOrderController.remove
);
router.post('/:id/submit', authenticate, authorize('sales:update'), validate([idParam]), salesOrderController.submit);
router.post('/:id/approve', authenticate, validate([idParam]), salesOrderController.approve);
router.post('/:id/return', authenticate, authorize('sales:update'), validate([idParam]), salesOrderController.returnToDraft);
router.post(
  '/:id/plan-production',
  authenticate,
  authorize('production:update'),
  validate([idParam]),
  salesOrderController.planProduction
);
router.post(
  '/:id/advance',
  authenticate,
  authorize('production:update'),
  validate([idParam]),
  salesOrderController.advance
);
router.post(
  '/:id/cancel',
  authenticate,
  authorize.any('sales:update', 'production:update'),
  validate([idParam]),
  salesOrderController.cancel
);
router.post(
  '/:id/attachments',
  authenticate,
  authorize('sales:update'),
  validate([idParam]),
  upload.single('file'),
  salesOrderController.addAttachment
);
router.delete(
  '/:id/attachments/:attachmentId',
  authenticate,
  authorize('sales:update'),
  validate([idParam, attachmentParam]),
  salesOrderController.removeAttachment
);
router.get(
  '/:id/attachments/:attachmentId/file',
  authenticate,
  canView,
  validate([idParam, attachmentParam]),
  salesOrderController.downloadAttachment
);

module.exports = router;
