const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const upload = require('../../middlewares/upload');
const mediaController = require('./media.controller');

const router = express.Router();

router.post('/', authenticate, upload.single('file'), mediaController.upload);

module.exports = router;
