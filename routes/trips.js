const router = require('express').Router();
const c = require('../controllers/tripController');
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Trips
 *   description: Trip lifecycle management
 */

router.use(authenticate); router.use(schoolTenancy);

/**
 * @swagger
 * /api/trips:
 *   get:
 *     summary: List trips for the school
 *     tags: [Trips]
 *     responses:
 *       200:
 *         description: List of trips
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 trips:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Trip'
 */
router.get('/', c.getAll);

/**
 * @swagger
 * /api/trips:
 *   post:
 *     summary: Create/schedule a new trip
 *     tags: [Trips]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [routeId, type, scheduledDate]
 *             properties:
 *               routeId:
 *                 type: integer
 *               type:
 *                 type: string
 *                 enum: [morning_pickup, afternoon_dropoff]
 *               scheduledDate:
 *                 type: string
 *                 format: date
 *                 example: "2026-05-28"
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Trip created
 */
router.post('/', authorize('school_admin','coordinator','driver'), c.create);

/**
 * @swagger
 * /api/trips/{id}/start:
 *   put:
 *     summary: Start a trip (sets status to in_progress)
 *     tags: [Trips]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Trip started
 *       404:
 *         description: Trip not found
 */
router.put('/:id/start', authorize('school_admin','coordinator','driver'), c.startTrip);

/**
 * @swagger
 * /api/trips/{id}/end:
 *   put:
 *     summary: End a trip (sets status to completed)
 *     tags: [Trips]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Trip ended
 *       404:
 *         description: Trip not found
 */
router.put('/:id/end', authorize('school_admin','coordinator','driver'), c.endTrip);

/**
 * @swagger
 * /api/trips/{id}/log:
 *   post:
 *     summary: Log a pickup or drop-off event for a student
 *     tags: [Trips]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId, action]
 *             properties:
 *               studentId:
 *                 type: integer
 *               action:
 *                 type: string
 *                 enum: [picked_up, dropped_off, absent]
 *               lat:
 *                 type: number
 *                 format: double
 *               lng:
 *                 type: number
 *                 format: double
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Action logged
 */
router.post('/:id/log', authorize('school_admin','coordinator','driver'), c.logAction);

/**
 * @swagger
 * /api/trips/{id}/logs:
 *   get:
 *     summary: Get all logs for a trip
 *     tags: [Trips]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Trip logs
 */
router.get('/:id/logs', c.getTripLogs);

module.exports = router;
