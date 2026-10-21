const { param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const bank = require('./bank.service');
const expenses = require('./expenses.service');

// Cash and bank accounts, bank statement import and matching.
const router = express.Router();
const id = (name) => validate([param(name).isMongoId().withMessage('Invalid id')]);
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

router.get('/accounts', authenticate, asyncHandler(async (req, res) => ok(res, await bank.moneyAccounts(req.user))));
router.post('/accounts', authenticate, asyncHandler(async (req, res) => ok(res, await bank.addBankAccount(req.user, req.body || {}), 201)));
router.get('/accounts/:id/statement', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await bank.listLines(req.user, req.params.id, req.query))));
router.post('/accounts/:id/statement', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await bank.importStatement(req.user, req.params.id, req.body?.rows), 201)));
router.delete('/accounts/:id/statement/:batch', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await bank.deleteBatch(req.user, req.params.id, req.params.batch))));
router.post('/accounts/:id/auto-match', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await bank.autoMatch(req.user, req.params.id))));
router.get('/accounts/:id/reconciliation', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await bank.reconciliation(req.user, req.params.id, req.query))));

router.get('/lines/:id/candidates', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await bank.candidates(req.user, req.params.id))));
router.post('/lines/:id/match', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await bank.matchLine(req.user, req.params.id, req.body?.voucherId))));
router.post('/lines/:id/unmatch', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await bank.unmatchLine(req.user, req.params.id))));
router.post('/lines/:id/ignore', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await bank.ignoreLine(req.user, req.params.id, req.body?.note))));
router.post('/lines/:id/entry', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await bank.entryFromLine(req.user, req.params.id, req.body || {}), 201)));

router.get('/expenses', authenticate, asyncHandler(async (req, res) => ok(res, await expenses.listExpenses(req.user, req.query))));
router.get('/expenses/options', authenticate, asyncHandler(async (req, res) => ok(res, await expenses.formOptions(req.user))));
router.post('/expenses', authenticate, asyncHandler(async (req, res) => ok(res, await expenses.createExpense(req.user, req.body || {}), 201)));

module.exports = router;
