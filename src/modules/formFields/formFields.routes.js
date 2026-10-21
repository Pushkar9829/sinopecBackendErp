const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const asyncHandler = require('../../utils/asyncHandler');
const formFields = require('./formFields.service');

// Every signed-in form reads the rules (to show ✱); only the owner changes them.
const router = express.Router();
router.get('/', authenticate, asyncHandler(async (req, res) => res.json({ success: true, data: await formFields.getRules() })));
router.put('/', authenticate, asyncHandler(async (req, res) => res.json({ success: true, data: await formFields.saveRules(req.user, req.body?.required) })));

module.exports = router;
