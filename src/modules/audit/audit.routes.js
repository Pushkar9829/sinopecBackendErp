const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const asyncHandler = require('../../utils/asyncHandler');
const auditService = require('./audit.service');

const router = express.Router();

router.get(
  '/',
  authenticate,
  authorize('audit:read'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await auditService.list(req.query) });
  })
);

router.get(
  '/meta',
  authenticate,
  authorize('audit:read'),
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: await auditService.meta() });
  })
);

module.exports = router;
