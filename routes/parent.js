const router = require('express').Router();
const c = require('../controllers/parentController');
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Parent
 *   description: Parent self-service (my children's trips)
 */

router.use(authenticate);
router.use(authorize('parent'));
router.use(schoolTenancy);

/**
 * @swagger
 * /api/parent/trip-history:
 *   get:
 *     summary: Completed, cancelled and missed journeys for the parent's children (default last 30 days)
 *     tags: [Parent]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 30
 *       - in: query
 *         name: schoolId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: studentId
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of completed trips with per-child pickup times
 */
router.get('/trip-history', c.getTripHistory);

/**
 * @swagger
 * /api/parent/upcoming-trips:
 *   get:
 *     summary: Scheduled journeys for the parent's children, starting on today's school-local date
 *     tags: [Parent]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: includeDisruptions
 *         description: Include missed/cancelled journeys with frozen participation, even after route reassignment
 *         schema:
 *           type: boolean
 *           default: false
 *       - in: query
 *         name: schoolId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: studentId
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Today's and upcoming journeys, optionally including missed/cancelled snapshots
 */
router.get('/upcoming-trips', c.getUpcomingTrips);

module.exports = router;
