const { body, param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const upload = require('../../middlewares/upload');
const validate = require('../../middlewares/validate');
const intakeController = require('./intake.controller');

const router = express.Router();
const idParam = param('id').isMongoId().withMessage('Invalid id');
const sales = [authenticate, authorize('sales:create')];
const proposalBody = body('proposal').isObject().withMessage('Proposal is required');

router.get('/whatsapp', intakeController.whatsappWebhook);
router.post('/whatsapp', intakeController.whatsappWebhook);
router.get('/gmail/callback', intakeController.gmailCallback);

router.get('/settings', ...sales, intakeController.getSettingsView);
router.put('/settings', ...sales, intakeController.saveSettingsView);
router.post('/gmail/start', ...sales, intakeController.gmailStart);
router.post(
  '/paste',
  ...sales,
  validate([body('text').trim().notEmpty().withMessage('Type a message to test')]),
  intakeController.paste
);
router.post('/panel', ...sales, validate([proposalBody]), intakeController.createPanel);
router.post('/panel/read', ...sales, upload.array('files', 5), intakeController.readPanel);

router.get('/', ...sales, intakeController.list);
router.put('/:id', ...sales, validate([idParam, proposalBody]), intakeController.saveProposal);
router.post('/:id/potential', ...sales, validate([idParam]), intakeController.markPotential);
router.post('/:id/not-order', ...sales, validate([idParam]), intakeController.markNotOrder);
router.post('/:id/reread', ...sales, validate([idParam]), intakeController.reread);
router.post('/:id/discard', ...sales, validate([idParam]), intakeController.discard);
router.get('/:id', ...sales, validate([idParam]), intakeController.getOne);

module.exports = router;
