const { body, param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const userController = require('./user.controller');

const router = express.Router();

const userIdParam = param('id').isMongoId().withMessage('Invalid user id');

router.get('/', authenticate, authorize('users:read'), userController.list);
router.get(
  '/directory',
  authenticate,
  authorize.any('users:read', 'production:read', 'inventory:read'),
  userController.directory
);

router.post(
  '/',
  authenticate,
  authorize('users:create'),
  validate([
    body('username')
      .trim()
      .isLength({ min: 3, max: 50 })
      .withMessage('Username must be 3-50 characters'),
    body('password')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters'),
    body('fullName').trim().notEmpty().withMessage('Full name is required'),
    body('roleId').isMongoId().withMessage('Valid roleId is required'),
    body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  ]),
  userController.create
);

router.patch(
  '/:id',
  authenticate,
  authorize('users:update'),
  validate([
    userIdParam,
    body('username')
      .optional()
      .trim()
      .isLength({ min: 3, max: 50 })
      .withMessage('Username must be 3-50 characters'),
    body('password')
      .optional()
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters'),
    body('fullName').optional().trim().notEmpty().withMessage('Full name cannot be empty'),
    body('roleId').optional().isMongoId().withMessage('Invalid roleId'),
    body('isActive').optional().isBoolean().withMessage('isActive must be a boolean'),
  ]),
  userController.update
);

router.delete(
  '/:id',
  authenticate,
  authorize('users:delete'),
  validate([userIdParam]),
  userController.remove
);

module.exports = router;
