const { param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const books = require('./books.service');
const { tdsSummary } = require('./books.tds');

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
router.get('/tds', authenticate, asyncHandler(async (req, res) => ok(res, await tdsSummary(req.user, req.query))));
router.get('/trial-balance', authenticate, asyncHandler(async (req, res) => ok(res, await books.trialBalance(req.user, req.query))));
router.post('/sync', authenticate, asyncHandler(async (req, res) => ok(res, await books.resync(req.user))));

module.exports = router;
