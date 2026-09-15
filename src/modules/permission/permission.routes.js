const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const permissionController = require('./permission.controller');

const router = express.Router();

router.get('/', authenticate, authorize('permissions:read'), permissionController.list);

module.exports = router;
