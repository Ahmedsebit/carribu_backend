const router = require('express').Router();
const c = require('../controllers/studentController');
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Students
 *   description: Student management
 */

router.use(authenticate); router.use(schoolTenancy);

/**
 * @swagger
 * /api/students:
 *   get:
 *     summary: List all students for the school
 *     tags: [Students]
 *     responses:
 *       200:
 *         description: List of students
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 students:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Student'
 */
router.get('/', c.getAll);

/**
 * @swagger
 * /api/students/{id}:
 *   get:
 *     summary: Get student by ID
 *     tags: [Students]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Student details
 *       404:
 *         description: Student not found
 */
router.get('/:id', c.getById);

/**
 * @swagger
 * /api/students:
 *   post:
 *     summary: Create a new student
 *     tags: [Students]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [firstName, lastName]
 *             properties:
 *               firstName:
 *                 type: string
 *                 example: Child
 *               lastName:
 *                 type: string
 *                 example: One
 *               grade:
 *                 type: string
 *                 example: Grade 3
 *               parentId:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Student created
 */
router.post('/', authorize('school_admin','coordinator'), c.create);

/**
 * @swagger
 * /api/students/{id}:
 *   put:
 *     summary: Update a student
 *     tags: [Students]
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
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               grade:
 *                 type: string
 *               parentId:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Student updated
 *       404:
 *         description: Student not found
 */
router.put('/:id', authorize('school_admin','coordinator'), c.update);

/**
 * @swagger
 * /api/students/{id}:
 *   delete:
 *     summary: Delete a student
 *     tags: [Students]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Student deleted
 *       404:
 *         description: Student not found
 */
router.delete('/:id', authorize('school_admin'), c.delete);

/**
 * @swagger
 * /api/students/{id}/assign-route:
 *   post:
 *     summary: Assign a student to a route
 *     tags: [Students]
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
 *             required: [routeId]
 *             properties:
 *               routeId:
 *                 type: integer
 *               stopOrder:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Student assigned to route
 */
router.post('/:id/assign-route', authorize('school_admin','coordinator'), c.assignRoute);

module.exports = router;
