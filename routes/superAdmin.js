const router = require('express').Router();
const c = require('../controllers/superAdminController');
const { authenticate, authorize } = require('../middleware/auth');

router.use(authenticate, authorize('super_admin'));

/**
 * @swagger
 * tags:
 *   name: Super Admin
 *   description: Platform-level management (super_admin only)
 */

// --- Platform Overview ---

/**
 * @swagger
 * /api/super-admin/overview:
 *   get:
 *     summary: Get platform-wide statistics
 *     tags: [Super Admin]
 *     responses:
 *       200:
 *         description: Platform overview stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 overview:
 *                   type: object
 *                   properties:
 *                     schoolCount:
 *                       type: integer
 *                     activeSchools:
 *                       type: integer
 *                     totalUsers:
 *                       type: integer
 *                     totalStudents:
 *                       type: integer
 *                     totalVehicles:
 *                       type: integer
 *                     totalRoutes:
 *                       type: integer
 *                     totalTrips:
 *                       type: integer
 *                     activeTrips:
 *                       type: integer
 */
router.get('/overview', c.platformOverview);

// --- School Management ---

/**
 * @swagger
 * /api/super-admin/schools:
 *   get:
 *     summary: List all schools with counts
 *     tags: [Super Admin]
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search schools by name
 *       - in: query
 *         name: isActive
 *         schema:
 *           type: boolean
 *         description: Filter by active status
 *     responses:
 *       200:
 *         description: List of schools with stats
 */
router.get('/schools', c.listSchools);

/**
 * @swagger
 * /api/super-admin/schools/{id}:
 *   get:
 *     summary: Get full school details with all related data
 *     tags: [Super Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: School with users, vehicles, students, routes
 *       404:
 *         description: School not found
 */
router.get('/schools/:id', c.getSchool);

/**
 * @swagger
 * /api/super-admin/schools/{id}/stats:
 *   get:
 *     summary: Get detailed stats for a specific school
 *     tags: [Super Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: School statistics
 *       404:
 *         description: School not found
 */
router.get('/schools/:id/stats', c.schoolStats);

/**
 * @swagger
 * /api/super-admin/schools:
 *   post:
 *     summary: Create a new school
 *     tags: [Super Admin]
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
 *               address:
 *                 type: string
 *               city:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               logoUrl:
 *                 type: string
 *     responses:
 *       201:
 *         description: School created
 */
router.post('/schools', c.createSchool);

/**
 * @swagger
 * /api/super-admin/schools/{id}:
 *   put:
 *     summary: Update a school
 *     tags: [Super Admin]
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
 *               logoUrl:
 *                 type: string
 *               isActive:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: School updated
 *       404:
 *         description: School not found
 */
router.put('/schools/:id', c.updateSchool);

/**
 * @swagger
 * /api/super-admin/schools/{id}/deactivate:
 *   post:
 *     summary: Deactivate a school and all its users
 *     tags: [Super Admin]
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
router.post('/schools/:id/deactivate', c.deactivateSchool);

/**
 * @swagger
 * /api/super-admin/schools/{id}/activate:
 *   post:
 *     summary: Activate a school
 *     tags: [Super Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: School activated
 *       404:
 *         description: School not found
 */
router.post('/schools/:id/activate', c.activateSchool);

// --- School Admin Management ---

/**
 * @swagger
 * /api/super-admin/admins:
 *   get:
 *     summary: List all school admins (optionally filter by schoolId)
 *     tags: [Super Admin]
 *     parameters:
 *       - in: query
 *         name: schoolId
 *         schema:
 *           type: integer
 *         description: Filter admins by school
 *     responses:
 *       200:
 *         description: List of school admins
 */
router.get('/admins', c.listSchoolAdmins);

/**
 * @swagger
 * /api/super-admin/admins:
 *   post:
 *     summary: Create a school admin for a specific school
 *     tags: [Super Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [schoolId, email, password, firstName, lastName]
 *             properties:
 *               schoolId:
 *                 type: integer
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
 *     responses:
 *       201:
 *         description: School admin created
 *       400:
 *         description: Validation error
 */
router.post('/admins', c.createSchoolAdmin);

/**
 * @swagger
 * /api/super-admin/admins/{id}:
 *   delete:
 *     summary: Deactivate a school admin
 *     tags: [Super Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: School admin deactivated
 *       404:
 *         description: User not found
 */
router.delete('/admins/:id', c.removeSchoolAdmin);

module.exports = router;
