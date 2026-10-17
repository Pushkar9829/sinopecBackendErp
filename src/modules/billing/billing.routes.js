const { param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const asyncHandler = require('../../utils/asyncHandler');
const billing = require('./billing.service');

// Each action checks its own permission in the service (Accounts, Sales and
// the Super Admin share this area with different rights).
const router = express.Router();
const id = (name) => param(name).isMongoId().withMessage('Invalid id');
const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

router.get('/orders/:orderId/invoice-draft', authenticate, validate([id('orderId')]), asyncHandler(async (req, res) => ok(res, await billing.invoiceDraft(req.user, req.params.orderId))));
router.post('/orders/:orderId/invoices', authenticate, validate([id('orderId')]), asyncHandler(async (req, res) => ok(res, await billing.createInvoice(req.user, req.params.orderId, req.body || {}), 201)));

router.get('/receivables', authenticate, asyncHandler(async (req, res) => ok(res, await billing.receivables(req.user))));
router.get('/invoices', authenticate, asyncHandler(async (req, res) => ok(res, await billing.listInvoices(req.user, { orderId: req.query.order, customerId: req.query.customer }))));
router.get('/invoices/:id', authenticate, validate([id('id')]), asyncHandler(async (req, res) => ok(res, await billing.getInvoice(req.user, req.params.id))));
router.post('/invoices/:id/cancel', authenticate, validate([id('id')]), asyncHandler(async (req, res) => ok(res, await billing.cancelInvoice(req.user, req.params.id, req.body?.reason))));

router.get('/customers/:id/ledger', authenticate, validate([id('id')]), asyncHandler(async (req, res) => ok(res, await billing.ledger(req.user, req.params.id))));
router.post('/customers/:id/openings', authenticate, validate([id('id')]), asyncHandler(async (req, res) => ok(res, await billing.addOpeningBill(req.user, req.params.id, req.body || {}), 201)));
router.post('/openings/import', authenticate, asyncHandler(async (req, res) => ok(res, await billing.importOpeningBills(req.user, req.body?.rows, req.body?.apply === true))));
router.post('/customers/:id/receipts', authenticate, validate([id('id')]), asyncHandler(async (req, res) => ok(res, await billing.addReceipt(req.user, req.params.id, req.body || {}), 201)));
router.post('/receipts/:id/void', authenticate, validate([id('id')]), asyncHandler(async (req, res) => ok(res, await billing.voidReceipt(req.user, req.params.id, req.body?.reason))));

module.exports = router;
