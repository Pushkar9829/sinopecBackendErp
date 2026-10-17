const { body, param } = require('express-validator');
const express = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const upload = require('../../middlewares/upload');
const validate = require('../../middlewares/validate');
const c = require('./intake.controller');

const router = express.Router();
const idParam = param('id').isMongoId().withMessage('Invalid id');
const canRead = [authenticate, authorize('intake:read')];
const canUpdate = [authenticate, authorize('intake:update')];
const canSetup = [authenticate, authorize('intake:settings')];
// Converting makes a sales order and copies files onto it.
const canConvert = [authenticate, authorize('intake:update', 'sales:create', 'sales:update')];
const proposalBody = body('proposal').isObject().withMessage('Proposal is required');

// Called by Meta and Google, not by a signed-in person.
router.get('/whatsapp', c.whatsappVerify);
router.post('/whatsapp', c.whatsappWebhook);
router.get('/gmail/callback', c.gmailCallback);

router.get('/settings', ...canSetup, c.getSettingsView);
router.put('/settings', ...canSetup, c.saveSettingsView);
router.post('/gmail/start', ...canSetup, c.gmailStart);
router.post('/gmail/disconnect', ...canSetup, c.gmailDisconnect);

router.get('/summary', ...canRead, c.summary);
router.post('/panel', ...canUpdate, validate([proposalBody]), c.createPanel);
router.post('/panel/read', ...canUpdate, upload.array('files', 5), c.readPanel);

router.get('/', ...canRead, c.list);
router.get('/:id', ...canRead, validate([idParam]), c.getOne);
router.get('/:id/match', ...canRead, validate([idParam]), c.match);
router.get('/:id/files/:fileId', ...canRead, validate([idParam, param('fileId').isMongoId()]), c.file);
router.put('/:id', ...canUpdate, validate([idParam, proposalBody]), c.saveProposal);
router.post('/:id/readings/:readingId/use', ...canUpdate, validate([idParam, param('readingId').isMongoId()]), c.useReading);
router.post('/:id/reread', ...canUpdate, validate([idParam]), c.reread);
router.post('/:id/not-order', ...canUpdate, validate([idParam]), c.markNotOrder);
router.post('/:id/discard', ...canUpdate, validate([idParam]), c.discard);
router.post('/:id/restore', ...canUpdate, validate([idParam]), c.restore);
router.post('/:id/customer', ...canUpdate, validate([idParam]), c.confirmCustomer);
router.delete('/:id/customer', ...canUpdate, validate([idParam]), c.clearCustomer);
router.post('/:id/convert', ...canConvert, validate([idParam]), c.convert);

module.exports = router;
