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
 *     summary: Completed trips that carried the parent's children (default last 30 days)
 *     tags: [Parent]
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 30
 *     responses:
 *       200:
 *         description: List of completed trips with per-child pickup times
 */
router.get('/trip-history', c.getTripHistory);

module.exports = router;
