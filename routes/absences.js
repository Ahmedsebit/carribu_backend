const router = require('express').Router();
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');
const controller = require('../controllers/absenceController');

router.use(authenticate, authorize('school_admin', 'coordinator'), schoolTenancy);
router.get('/', controller.getAll);
router.post('/:id/confirm', controller.confirm);
router.post('/:id/reject', controller.reject);

module.exports = router;
