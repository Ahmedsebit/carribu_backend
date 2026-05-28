const router = require('express').Router();
const c = require('../controllers/vehicleController');
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Vehicles
 *   description: Vehicle fleet management
 */

router.use(authenticate); router.use(schoolTenancy);

/**
 * @swagger
 * /api/vehicles/stats/summary:
 *   get:
 *     summary: Get fleet statistics summary
 *     tags: [Vehicles]
 *     responses:
 *       200:
 *         description: Vehicle stats
 */
router.get('/stats/summary', c.getStats);

/**
 * @swagger
 * /api/vehicles:
 *   get:
 *     summary: List all vehicles for the school
 *     tags: [Vehicles]
 *     responses:
 *       200:
 *         description: List of vehicles
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vehicles:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Vehicle'
 */
router.get('/', c.getAll);

/**
 * @swagger
 * /api/vehicles/{id}:
 *   get:
 *     summary: Get vehicle by ID
 *     tags: [Vehicles]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Vehicle details
 *       404:
 *         description: Vehicle not found
 */
router.get('/:id', c.getById);

/**
 * @swagger
 * /api/vehicles:
 *   post:
 *     summary: Add a new vehicle
 *     tags: [Vehicles]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [plateNumber, capacity]
 *             properties:
 *               plateNumber:
 *                 type: string
 *                 example: KDA 001A
 *               make:
 *                 type: string
 *                 example: Toyota
 *               model:
 *                 type: string
 *                 example: HiAce
 *               year:
 *                 type: integer
 *                 example: 2022
 *               capacity:
 *                 type: integer
 *                 example: 18
 *               color:
 *                 type: string
 *                 example: White
 *               status:
 *                 type: string
 *                 enum: [active, maintenance, retired]
 *               insuranceExpiry:
 *                 type: string
 *                 format: date
 *     responses:
 *       201:
 *         description: Vehicle created
 */
router.post('/', authorize('super_admin','admin','coordinator'), c.create);

/**
 * @swagger
 * /api/vehicles/{id}:
 *   put:
 *     summary: Update a vehicle
 *     tags: [Vehicles]
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
 *               plateNumber:
 *                 type: string
 *               make:
 *                 type: string
 *               model:
 *                 type: string
 *               year:
 *                 type: integer
 *               capacity:
 *                 type: integer
 *               color:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [active, maintenance, retired]
 *               insuranceExpiry:
 *                 type: string
 *                 format: date
 *     responses:
 *       200:
 *         description: Vehicle updated
 *       404:
 *         description: Vehicle not found
 */
router.put('/:id', authorize('super_admin','admin','coordinator'), c.update);

/**
 * @swagger
 * /api/vehicles/{id}:
 *   delete:
 *     summary: Delete a vehicle
 *     tags: [Vehicles]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Vehicle deleted
 *       404:
 *         description: Vehicle not found
 */
router.delete('/:id', authorize('super_admin','admin'), c.delete);

module.exports = router;
