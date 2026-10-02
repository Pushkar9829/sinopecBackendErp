const { body, param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const taskController = require('./task.controller');

const router = express.Router();
const idParam = param('id').isMongoId().withMessage('Invalid task id');
const canRead = authorize('tasks:read');
const canCreate = authorize('tasks:create');
const canUpdate = authorize('tasks:update');

router.get('/', authenticate, canRead, taskController.list);
router.get('/summary', authenticate, canRead, taskController.summary);
router.get('/assignees', authenticate, authorize.any('tasks:create', 'tasks:*'), taskController.assignees);
router.get(
  '/order/:orderId',
  authenticate,
  canRead,
  validate([param('orderId').isMongoId().withMessage('Invalid order id')]),
  taskController.forOrder
);
router.get('/:id', authenticate, canRead, validate([idParam]), taskController.get);
router.post(
  '/',
  authenticate,
  canCreate,
  validate([body('title').trim().notEmpty().withMessage('Title is required')]),
  taskController.create
);
router.patch('/:id', authenticate, canUpdate, validate([idParam]), taskController.update);
router.post('/:id/claim', authenticate, canUpdate, validate([idParam]), taskController.claim);
router.post(
  '/:id/comments',
  authenticate,
  canRead,
  validate([idParam, body('text').trim().notEmpty().withMessage('Comment cannot be empty')]),
  taskController.comment
);

module.exports = router;
