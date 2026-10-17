const { param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const supplierService = require('./supplier.service');

const router = express.Router();
const idParam = param('id').isMongoId().withMessage('Invalid id');
// Suppliers belong to the store: whoever manages stock manages them.
const canRead = authorize.any('inventory:read', 'production:read', 'sales:read');

router.get(
  '/',
  authenticate,
  canRead,
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await supplierService.listSuppliers({ activeOnly: req.query.active === '1' }) });
  })
);
router.get(
  '/:id',
  authenticate,
  canRead,
  validate([idParam]),
  asyncHandler(async (req, res) => res.json({ success: true, data: await supplierService.getSupplier(req.params.id) }))
);
router.post(
  '/',
  authenticate,
  authorize('inventory:create'),
  asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await supplierService.createSupplier(req.body || {}) }))
);
router.patch(
  '/:id',
  authenticate,
  authorize('inventory:update'),
  validate([idParam]),
  asyncHandler(async (req, res) => res.json({ success: true, data: await supplierService.updateSupplier(req.params.id, req.body || {}) }))
);
router.delete(
  '/:id',
  authenticate,
  authorize('inventory:delete'),
  validate([idParam]),
  asyncHandler(async (req, res) => {
    await supplierService.deleteSupplier(req.params.id);
    res.json({ success: true, message: 'Supplier deleted' });
  })
);

module.exports = router;
