const { query } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const { accountsReport } = require('./reports.accounts');
const { overviewReport } = require('./reports.overview');
const { salesReport } = require('./reports.sales');

// Each report checks its own permission (Accounts, Sales, Production... see
// the report files), so one login only sees the reports for its work.
const router = express.Router();
const period = validate([
  query('from').optional().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('from must be YYYY-MM-DD'),
  query('to').optional().matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('to must be YYYY-MM-DD'),
]);
const ok = (res, data) => res.json({ success: true, data });

router.get('/overview', authenticate, period, asyncHandler(async (req, res) => ok(res, await overviewReport(req.user, req.query))));
router.get('/sales', authenticate, period, asyncHandler(async (req, res) => ok(res, await salesReport(req.user, req.query))));
router.get('/accounts', authenticate, period, asyncHandler(async (req, res) => ok(res, await accountsReport(req.user, req.query))));

module.exports = router;
