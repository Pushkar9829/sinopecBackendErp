const { body } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const authController = require('./auth.controller');

const router = express.Router();

router.post(
  '/login',
  validate([
    body('username').trim().notEmpty().withMessage('Username is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ]),
  authController.login
);

router.post('/logout', authenticate, authController.logout);
router.post('/refresh', authController.refresh);
router.get('/me', authenticate, authController.me);

module.exports = router;
