const { body } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const validate = require('../../middlewares/validate');
const { loginLimiters, refreshLimiter, logoutLimiter } = require('../../middlewares/rateLimit');
const authController = require('./auth.controller');

const router = express.Router();

router.post(
  '/login',
  ...loginLimiters,
  validate([
    body('username').isString().withMessage('Username is required').bail().trim().notEmpty().withMessage('Username is required'),
    body('password').isString().withMessage('Password is required').bail().notEmpty().withMessage('Password is required'),
  ]),
  authController.login
);

router.post('/logout', logoutLimiter, authController.logout);
router.post('/logout-all', authenticate, authController.logoutAll);
router.post('/refresh', refreshLimiter, authController.refresh);
router.get('/me', authenticate, authController.me);

module.exports = router;
