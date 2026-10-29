const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const asyncHandler = require('../../utils/asyncHandler');
const layouts = require('./documentLayouts.service');

// Every print page reads its layout; only the owner changes them.
const router = express.Router();
const ok = (res, data) => res.json({ success: true, data });
router.get('/', authenticate, asyncHandler(async (req, res) => ok(res, await layouts.listLayouts())));
router.get('/order-fields', authenticate, asyncHandler(async (req, res) => ok(res, await layouts.orderFields())));
router.get('/:id', authenticate, asyncHandler(async (req, res) => ok(res, await layouts.getLayout(req.params.id))));
router.put('/:id', authenticate, asyncHandler(async (req, res) => ok(res, await layouts.saveLayout(req.user, req.params.id, req.body || {}))));
router.delete('/:id', authenticate, asyncHandler(async (req, res) => ok(res, await layouts.resetLayout(req.user, req.params.id))));

module.exports = router;
