const router = require('express').Router();
const c = require('../controllers/locationController');
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Location
 *   description: Real-time bus location tracking
 */

router.use(authenticate); router.use(schoolTenancy);

/**
 * @swagger
 * /api/location/update:
 *   post:
 *     summary: Update bus location from the assigned driver's phone (unlinked vehicles only)
 *     tags: [Location]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [tripId, lat, lng]
 *             properties:
 *               tripId:
 *                 type: integer
 *               lat:
 *                 type: number
 *                 format: double
 *                 example: -1.2641
 *               lng:
 *                 type: number
 *                 format: double
 *                 example: 36.8053
 *               speed:
 *                 type: number
 *               heading:
 *                 type: number
 *     responses:
 *       201:
 *         description: Location updated
 *       409:
 *         description: Linked Traccar device is authoritative; phone sharing must stop (TRACCAR_LOCATION_REQUIRED)
 */
router.post('/update', authorize('school_admin','coordinator','driver'), c.updateLocation);

/**
 * @swagger
 * /api/location/bus/{tripId}:
 *   get:
 *     summary: Get current bus location for a trip
 *     tags: [Location]
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Current bus location
 */
router.get('/bus/:tripId', c.getBusLocation);

/**
 * @swagger
 * /api/location/history/{tripId}:
 *   get:
 *     summary: Get location history for a trip
 *     tags: [Location]
 *     parameters:
 *       - in: path
 *         name: tripId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Array of location points
 */
router.get('/history/:tripId', c.getLocationHistory);

/**
 * @swagger
 * /api/location/my-bus:
 *   get:
 *     summary: Get current location of the bus carrying the parent's child
 *     tags: [Location]
 *     responses:
 *       200:
 *         description: Bus location for parent's child
 */
router.get('/my-bus', authorize('parent'), c.getMyChildBus);

module.exports = router;
