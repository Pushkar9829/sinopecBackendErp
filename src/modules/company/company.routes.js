const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { isSuperAdmin } = require('../../utils/permissions');
const companyService = require('./company.service');

const router = express.Router();

// Everyone signed in can read it (the order and invoice screens need it);
// only the Super Admin changes it.
router.get(
  '/',
  authenticate,
  asyncHandler(async (_req, res) => res.json({ success: true, data: await companyService.getSettings() }))
);

router.put(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    if (!isSuperAdmin(req.user)) throw new ApiError(403, 'Only the Super Admin can change company details');
    res.json({ success: true, data: await companyService.saveSettings(req.body || {}) });
  })
);

module.exports = router;
