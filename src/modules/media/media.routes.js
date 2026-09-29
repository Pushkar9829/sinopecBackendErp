const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const upload = require('../../middlewares/upload');
const mediaController = require('./media.controller');

const router = express.Router();

router.post(
  '/',
  authenticate,
  authorize.any('sales:create', 'sales:update', 'inventory:create', 'inventory:update', 'production:update'),
  upload.single('file'),
  mediaController.upload
);

module.exports = router;
