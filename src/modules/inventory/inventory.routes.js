const { body, param, query } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const inventoryController = require('./inventory.controller');

const router = express.Router();
const idParam = param('id').isMongoId().withMessage('Invalid id');

const stageRead = authorize.any('inventory:read', 'production:read');
const stageCreate = authorize.any('inventory:create', 'production:create');
const stageUpdate = authorize.any('inventory:update', 'production:update');
const stageDelete = authorize.any('inventory:delete', 'production:delete');

router.get('/stages', authenticate, stageRead, inventoryController.listStages);
router.get(
  '/stages/:id',
  authenticate,
  stageRead,
  validate([idParam]),
  inventoryController.getStage
);
router.post(
  '/stages',
  authenticate,
  stageCreate,
  validate([body('name').trim().notEmpty().withMessage('Stage name is required')]),
  inventoryController.createStage
);
router.patch(
  '/stages/:id',
  authenticate,
  stageUpdate,
  validate([
    idParam,
    body('name').optional().trim().notEmpty().withMessage('Stage name cannot be empty'),
    body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
    body('machineIds').optional().isArray().withMessage('machineIds must be an array'),
    body('machineIds.*').optional().isMongoId().withMessage('Invalid machine id'),
    body('userIds').optional().isArray().withMessage('userIds must be an array'),
    body('userIds.*').optional().isMongoId().withMessage('Invalid user id'),
  ]),
  inventoryController.updateStage
);
router.delete(
  '/stages/:id',
  authenticate,
  stageDelete,
  validate([idParam]),
  inventoryController.removeStage
);

router.get('/meta', authenticate, authorize('inventory:read'), inventoryController.meta);

router.get(
  '/items',
  authenticate,
  authorize('inventory:read'),
  validate([
    query('category')
      .optional()
      .isIn(['raw', 'output', 'waste'])
      .withMessage('Category must be raw, output, or waste'),
  ]),
  inventoryController.listItems
);
router.get(
  '/items/:id',
  authenticate,
  authorize('inventory:read'),
  validate([idParam]),
  inventoryController.getItem
);
router.post(
  '/items',
  authenticate,
  authorize('inventory:create'),
  validate([
    body('category').isIn(['raw', 'output', 'waste']).withMessage('Category must be raw, output, or waste'),
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('materialType').trim().notEmpty().withMessage('Material type is required'),
    body('unit').trim().notEmpty().withMessage('Unit is required'),
    body('quantity').isFloat({ min: 0 }).withMessage('Quantity must be 0 or greater'),
    body('stageId').optional({ nullable: true, checkFalsy: true }).isMongoId().withMessage('Invalid stage'),
    body('notes').optional().isString(),
  ]),
  inventoryController.createItem
);
router.patch(
  '/items/:id',
  authenticate,
  authorize('inventory:update'),
  validate([
    idParam,
    body('category').optional().isIn(['raw', 'output', 'waste']).withMessage('Category must be raw, output, or waste'),
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
    body('materialType').optional().trim().notEmpty().withMessage('Material type cannot be empty'),
    body('unit').optional().trim().notEmpty().withMessage('Unit cannot be empty'),
    body('quantity').optional().isFloat({ min: 0 }).withMessage('Quantity must be 0 or greater'),
    body('stageId').optional({ nullable: true, checkFalsy: true }).isMongoId().withMessage('Invalid stage'),
  ]),
  inventoryController.updateItem
);
router.delete(
  '/items/:id',
  authenticate,
  authorize('inventory:delete'),
  validate([idParam]),
  inventoryController.removeItem
);

module.exports = router;
