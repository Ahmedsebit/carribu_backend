const router = require('express').Router();
const c = require('../controllers/driverController');
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Driver
 *   description: Driver-specific actions (my routes, my trips)
 */

router.use(authenticate);
router.use(authorize('school_admin','coordinator','driver'));
router.use(schoolTenancy);

/**
 * @swagger
 * /api/driver/my-routes:
 *   get:
 *     summary: Get routes assigned to the current driver
 *     tags: [Driver]
 *     responses:
 *       200:
 *         description: List of assigned routes
 */
router.get('/my-routes', c.getMyRoutes);

/**
 * @swagger
 * /api/driver/my-trips:
 *   get:
 *     summary: Get trips for the current driver
 *     tags: [Driver]
 *     responses:
 *       200:
 *         description: List of driver's trips
 */
router.get('/my-trips', c.getMyTrips);

/**
 * @swagger
 * /api/driver/trip-history:
 *   get:
 *     summary: Get the driver's completed trips (default last 30 days)
 *     tags: [Driver]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 30
 *     responses:
 *       200:
 *         description: List of completed trips with per-student pickup times
 */
router.get('/trip-history', c.getTripHistory);

/**
 * @swagger
 * /api/driver/active-trip:
 *   get:
 *     summary: Get the driver's currently active (in_progress) trip
 *     tags: [Driver]
 *     responses:
 *       200:
 *         description: Active trip or null
 */
router.get('/active-trip', c.getActiveTrip);

module.exports = router;
