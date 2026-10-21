const { param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const p = require('./purchases.service');

// Supplier bills, payments to suppliers, debit notes and payables. Each action
// checks accounts permissions in the service.
const router = express.Router();
const id = (name) => validate([param(name).isMongoId().withMessage('Invalid id')]);
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

router.get('/options', authenticate, asyncHandler(async (req, res) => ok(res, await p.formOptions(req.user))));
router.get('/payables', authenticate, asyncHandler(async (req, res) => ok(res, await p.payables(req.user))));

router.get('/bills', authenticate, asyncHandler(async (req, res) => ok(res, await p.listBills(req.user, req.query))));
router.post('/bills', authenticate, asyncHandler(async (req, res) => ok(res, await p.createBill(req.user, req.body || {}), 201)));
router.get('/bills/:id', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await p.getBill(req.user, req.params.id))));
router.post('/bills/:id/cancel', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await p.cancelBill(req.user, req.params.id, req.body?.reason))));

router.get('/payments', authenticate, asyncHandler(async (req, res) => ok(res, await p.listPayments(req.user, req.query))));
router.post('/payments/:id/void', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await p.voidPayment(req.user, req.params.id, req.body?.reason))));
router.get('/debit-notes', authenticate, asyncHandler(async (req, res) => ok(res, await p.listDebitNotes(req.user, req.query))));
router.post('/debit-notes/:id/cancel', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await p.cancelDebitNote(req.user, req.params.id, req.body?.reason))));

router.get('/suppliers/:id/account', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await p.supplierLedger(req.user, req.params.id))));
router.get('/suppliers/:id/lots', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await p.supplierLots(req.user, req.params.id))));
router.post('/suppliers/:id/openings', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await p.addOpeningBill(req.user, req.params.id, req.body || {}), 201)));
router.post('/suppliers/:id/payments', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await p.createPayment(req.user, req.params.id, req.body || {}), 201)));
router.post('/suppliers/:id/debit-notes', authenticate, id('id'), asyncHandler(async (req, res) => ok(res, await p.createDebitNote(req.user, req.params.id, req.body || {}), 201)));

module.exports = router;
