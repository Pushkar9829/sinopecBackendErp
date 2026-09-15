const { body, param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const roleController = require('./role.controller');

const router = express.Router();

router.get('/', authenticate, authorize('roles:read'), roleController.list);

router.patch(
  '/:id/permissions',
  authenticate,
  authorize('roles:update'),
  validate([
    param('id').isMongoId().withMessage('Invalid role id'),
    body('permissionIds')
      .isArray()
      .withMessage('permissionIds must be an array'),
    body('permissionIds.*').isMongoId().withMessage('Invalid permission id'),
  ]),
  roleController.updatePermissions
);

module.exports = router;
