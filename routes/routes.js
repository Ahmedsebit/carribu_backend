const router = require('express').Router();
const c = require('../controllers/routeController');
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Routes
 *   description: Bus route management
 */

router.use(authenticate); router.use(schoolTenancy);

/**
 * @swagger
 * /api/routes:
 *   get:
 *     summary: List all routes for the school
 *     tags: [Routes]
 *     responses:
 *       200:
 *         description: List of routes with assigned vehicle, driver, and students
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 routes:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Route'
 */
router.get('/', c.getAll);

/**
 * @swagger
 * /api/routes/{id}:
 *   get:
 *     summary: Get route by ID
 *     tags: [Routes]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Route details with students
 *       404:
 *         description: Route not found
 */
router.get('/:id', c.getById);

/**
 * @swagger
 * /api/routes:
 *   post:
 *     summary: Create a new route
 *     tags: [Routes]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Westlands Route
 *               description:
 *                 type: string
 *               vehicleId:
 *                 type: integer
 *               driverId:
 *                 type: integer
 *               type:
 *                 type: string
 *                 enum: [morning, afternoon, both]
 *               grades:
 *                 type: array
 *                 items:
 *                   type: string
 *               departureTime:
 *                 type: string
 *                 example: "07:00"
 *               studentIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       201:
 *         description: Route created
 */
router.post('/', authorize('school_admin','coordinator'), c.create);

/**
 * @swagger
 * /api/routes/suggest-students:
 *   post:
 *     summary: Suggest students for a route based on proximity
 *     tags: [Routes]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               grades:
 *                 type: array
 *                 items:
 *                   type: string
 *               maxDistance:
 *                 type: number
 *     responses:
 *       200:
 *         description: Suggested students
 */
router.post('/suggest-students', authorize('school_admin','coordinator'), c.suggestStudents);

/**
 * @swagger
 * /api/routes/{id}:
 *   put:
 *     summary: Update a route
 *     tags: [Routes]
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
 *             properties:
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               vehicleId:
 *                 type: integer
 *               driverId:
 *                 type: integer
 *               type:
 *                 type: string
 *                 enum: [morning, afternoon, both]
 *               studentIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       200:
 *         description: Route updated
 *       404:
 *         description: Route not found
 */
router.put('/:id', authorize('school_admin','coordinator'), c.update);

/**
 * @swagger
 * /api/routes/{id}:
 *   delete:
 *     summary: Deactivate a route (soft delete)
 *     tags: [Routes]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Route deactivated
 *       404:
 *         description: Route not found
 */
router.delete('/:id', authorize('school_admin'), c.delete);

module.exports = router;
