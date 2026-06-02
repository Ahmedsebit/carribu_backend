const router = require('express').Router();
const { authenticate, authorize } = require('../middleware/auth');
const parentController = require('../controllers/parentController');

/**
 * @swagger
 * tags:
 *   name: Parents
 *   description: Parent management (admin/coordinator)
 */

router.use(authenticate);
router.use(authorize('school_admin', 'coordinator'));

/**
 * @swagger
 * /api/parents:
 *   get:
 *     summary: List all parents for the school
 *     tags: [Parents]
 *     responses:
 *       200:
 *         description: List of parents with children
 */
router.get('/', parentController.listParents);

/**
 * @swagger
 * /api/parents/{id}:
 *   get:
 *     summary: Get parent by ID
 *     tags: [Parents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Parent details with children
 *       404:
 *         description: Parent not found
 */
router.get('/:id', parentController.getParent);

/**
 * @swagger
 * /api/parents:
 *   post:
 *     summary: Create a new parent
 *     tags: [Parents]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, firstName, lastName, phone]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *               phone:
 *                 type: string
 *               pickupAddress:
 *                 type: string
 *               pickupLat:
 *                 type: number
 *               pickupLng:
 *                 type: number
 *     responses:
 *       201:
 *         description: Parent created
 */
router.post('/', parentController.createParent);

/**
 * @swagger
 * /api/parents/{id}:
 *   put:
 *     summary: Update a parent
 *     tags: [Parents]
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
 *               phone:
 *                 type: string
 *               pickupAddress:
 *                 type: string
 *               pickupLat:
 *                 type: number
 *               pickupLng:
 *                 type: number
 *     responses:
 *       200:
 *         description: Parent updated
 *       404:
 *         description: Parent not found
 */
router.put('/:id', parentController.updateParent);

/**
 * @swagger
 * /api/parents/{id}:
 *   delete:
 *     summary: Deactivate a parent
 *     tags: [Parents]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Parent deactivated
 *       404:
 *         description: Parent not found
 */
router.delete('/:id', parentController.deleteParent);

module.exports = router;
