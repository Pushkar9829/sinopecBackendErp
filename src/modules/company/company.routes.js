const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const ApiError = require('../../utils/ApiError');
const asyncHandler = require('../../utils/asyncHandler');
const { hasPermission, isSuperAdmin } = require('../../utils/permissions');
const companyService = require('./company.service');

const router = express.Router();

// Bank account, IFSC and PAN only go to people who print invoices or
// statements (accounts / sales) and the Super Admin.
const PRIVATE_FIELDS = ['pan', 'bankName', 'bankAccountName', 'bankAccountNumber', 'bankIfsc', 'bankBranch'];
function canSeePrivate(user) {
  return isSuperAdmin(user) || hasPermission(user, 'accounts:read') || hasPermission(user, 'sales:read');
}

// Everyone signed in can read it (the order and invoice screens need it);
// only the Super Admin changes it.
router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const data = await companyService.getSettings();
    if (!canSeePrivate(req.user)) for (const field of PRIVATE_FIELDS) delete data[field];
    res.json({ success: true, data });
  })
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
