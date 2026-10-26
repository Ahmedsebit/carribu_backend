const router = require('express').Router();
const controller = require('../controllers/trackerController');
const { authenticateTracker } = require('../middleware/trackerWebhook');

router.use(authenticateTracker);
router.post('/position', controller.position);
router.post('/event', controller.event);

module.exports = router;
