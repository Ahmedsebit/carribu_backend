const router = require('express').Router();
const c = require('../controllers/schoolController');
const { authenticate, authorize } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Schools
 *   description: School management
 */

router.use(authenticate);

/**
 * @swagger
 * /api/schools:
 *   get:
 *     summary: List all schools (scoped to own school for non-super_admin)
 *     tags: [Schools]
 *     responses:
 *       200:
 *         description: List of schools with counts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 schools:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/School'
 *                       - type: object
 *                         properties:
 *                           vehicleCount:
 *                             type: integer
 *                           studentCount:
 *                             type: integer
 *                           routeCount:
 *                             type: integer
 */
router.get('/', c.getAll);

/**
 * @swagger
 * /api/schools/{id}:
 *   get:
 *     summary: Get school by ID (includes vehicles and users)
 *     tags: [Schools]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: School details
 *       404:
 *         description: School not found
 */
router.get('/:id', c.getById);

/**
 * @swagger
 * /api/schools/{id}/dashboard:
 *   get:
 *     summary: Get school dashboard stats
 *     tags: [Schools]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Dashboard statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dashboard:
 *                   type: object
 *                   properties:
 *                     schoolId:
 *                       type: integer
 *                     vehicleCount:
 *                       type: integer
 *                     studentCount:
 *                       type: integer
 *                     routeCount:
 *                       type: integer
 *                     driverCount:
 *                       type: integer
 */
router.get('/:id/dashboard', c.getDashboard);

/**
 * @swagger
 * /api/schools:
 *   post:
 *     summary: Create a new school
 *     tags: [Schools]
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
 *                 example: Nairobi Academy
 *               address:
 *                 type: string
 *               city:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       201:
 *         description: School created
 */
router.post('/', authorize('school_admin'), c.create);

/**
 * @swagger
 * /api/schools/{id}:
 *   put:
 *     summary: Update a school
 *     tags: [Schools]
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
 *               address:
 *                 type: string
 *               city:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: School updated
 *       404:
 *         description: School not found
 */
router.put('/:id', authorize('school_admin'), c.update);

/**
 * @swagger
 * /api/schools/{id}:
 *   delete:
 *     summary: Deactivate a school (soft delete)
 *     tags: [Schools]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: School deactivated
 *       404:
 *         description: School not found
 */
router.delete('/:id', authorize('school_admin'), c.delete);

module.exports = router;
