const router = require('express').Router();
const c = require('../controllers/locationController');
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');
router.use(authenticate); router.use(schoolTenancy);
router.post('/update', authorize('super_admin','admin','coordinator','driver'), c.updateLocation);
router.get('/bus/:tripId', c.getBusLocation);
router.get('/history/:tripId', c.getLocationHistory);
router.get('/my-bus', authorize('parent'), c.getMyChildBus);
module.exports = router;
