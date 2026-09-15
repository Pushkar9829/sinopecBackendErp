const { body, param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const customerController = require('./customer.controller');

const router = express.Router();
const idParam = param('id').isMongoId().withMessage('Invalid id');

router.get('/', authenticate, authorize('sales:read'), customerController.list);
router.get('/:id', authenticate, authorize('sales:read'), validate([idParam]), customerController.getOne);
router.post(
  '/',
  authenticate,
  authorize('sales:create'),
  validate([body('name').trim().notEmpty().withMessage('Customer name is required')]),
  customerController.create
);
router.patch(
  '/:id',
  authenticate,
  authorize('sales:update'),
  validate([
    idParam,
    body('name').optional().trim().notEmpty().withMessage('Customer name cannot be empty'),
    body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  ]),
  customerController.update
);
router.delete(
  '/:id',
  authenticate,
  authorize('sales:delete'),
  validate([idParam]),
  customerController.remove
);

module.exports = router;
