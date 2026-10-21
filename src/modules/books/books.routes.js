const { param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const books = require('./books.service');
const { tdsSummary } = require('./books.tds');
const statements = require('./books.statements');

// The books (chart of accounts, vouchers, ledger, trial balance). Each action
// checks accounts permissions in the service.
const router = express.Router();
const id = (name) => validate([param(name).isMongoId().withMessage('Invalid id')]);
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

router.get('/settings', authenticate, asyncHandler(async (req, res) => ok(res, await books.getSettings(req.user))));
router.put('/settings', authenticate, asyncHandler(async (req, res) => ok(res, await books.saveSettings(req.user, req.body || {}))));

router.get('/accounts', authenticate, asyncHandler(async (req, res) => ok(res, await books.listAccounts(req.user))));
router.post('/accounts', authenticate, asyncHandler(async (req, res) => ok(res, await books.createAccount(req.user, req.body || {}), 201)));
router.patch('/accounts/:id', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await books.updateAccount(req.user, req.params.id, req.body || {}))));
router.delete('/accounts/:id', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await books.deleteAccount(req.user, req.params.id))));
router.put('/openings', authenticate, asyncHandler(async (req, res) => ok(res, await books.saveOpenings(req.user, req.body?.rows))));

router.get('/vouchers', authenticate, asyncHandler(async (req, res) => ok(res, await books.listVouchers(req.user, req.query))));
router.get('/vouchers/:id', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await books.getVoucher(req.user, req.params.id))));
router.post('/vouchers', authenticate, asyncHandler(async (req, res) => ok(res, await books.createVoucher(req.user, req.body || {}), 201)));
router.post('/vouchers/:id/cancel', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await books.cancelVoucher(req.user, req.params.id, req.body?.reason))));

router.get('/ledger/:accountId', authenticate, id('accountId'), asyncHandler(async (req, res) => ok(res, await books.ledger(req.user, req.params.accountId, req.query))));
router.get('/statements/profit-loss', authenticate, asyncHandler(async (req, res) => ok(res, await statements.profitAndLoss(req.user, req.query))));
router.get('/statements/balance-sheet', authenticate, asyncHandler(async (req, res) => ok(res, await statements.balanceSheet(req.user, req.query))));
router.get('/statements/cash-flow', authenticate, asyncHandler(async (req, res) => ok(res, await statements.cashFlow(req.user, req.query))));
router.get('/statements/gstr3b', authenticate, asyncHandler(async (req, res) => ok(res, await statements.gstr3b(req.user, req.query))));
router.get('/closing-stock', authenticate, asyncHandler(async (req, res) => ok(res, await statements.listClosingStock(req.user))));
router.put('/closing-stock', authenticate, asyncHandler(async (req, res) => ok(res, await statements.saveClosingStock(req.user, req.body || {}))));
router.delete('/closing-stock/:day', authenticate, asyncHandler(async (req, res) => ok(res, await statements.deleteClosingStock(req.user, req.params.day))));
router.post('/years/:fy/close', authenticate, asyncHandler(async (req, res) => ok(res, await statements.closeYear(req.user, req.params.fy))));
router.post('/years/:fy/reopen', authenticate, asyncHandler(async (req, res) => ok(res, await statements.reopenYear(req.user, req.params.fy))));
router.get(
  '/export/tally',
  authenticate,
  asyncHandler(async (req, res) => {
    const file = await statements.tallyExport(req.user, req.query);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.body);
  })
);
router.get('/tds', authenticate, asyncHandler(async (req, res) => ok(res, await tdsSummary(req.user, req.query))));
router.get('/trial-balance', authenticate, asyncHandler(async (req, res) => ok(res, await books.trialBalance(req.user, req.query))));
router.post('/sync', authenticate, asyncHandler(async (req, res) => ok(res, await books.resync(req.user))));

module.exports = router;
