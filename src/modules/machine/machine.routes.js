const { body, param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const machineController = require('./machine.controller');

const router = express.Router();
const idParam = param('id').isMongoId().withMessage('Invalid machine id');
const canRead = authorize.any('production:read', 'inventory:read');
const canCreate = authorize.any('production:create', 'inventory:create');
const canUpdate = authorize.any('production:update', 'inventory:update');
const canDelete = authorize.any('production:delete', 'inventory:delete');

router.get('/', authenticate, canRead, machineController.list);
router.get('/:id', authenticate, canRead, validate([idParam]), machineController.get);
router.post(
  '/',
  authenticate,
  canCreate,
  validate([body('name').trim().notEmpty().withMessage('Machine name is required')]),
  machineController.create
);
router.patch(
  '/:id',
  authenticate,
  canUpdate,
  validate([
    idParam,
    body('name').optional().trim().notEmpty().withMessage('Machine name cannot be empty'),
    body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  ]),
  machineController.update
);
router.delete('/:id', authenticate, canDelete, validate([idParam]), machineController.remove);

module.exports = router;
