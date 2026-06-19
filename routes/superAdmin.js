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
/**
 * @swagger
 * /api/super-admin/admins/{id}/reset-password:
 *   post:
 *     summary: Reset a school admin's password and email it to them
 *     tags: [Super Admin]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Password reset and emailed
 *       404:
 *         description: User not found
 */
router.post('/admins/:id/reset-password', c.resetAdminPassword);

router.delete('/admins/:id', c.removeSchoolAdmin);

// --- Monitoring Routes ---
const m = require('../controllers/monitoringController');

/**
 * @swagger
 * /api/super-admin/monitoring/active-trips:
 *   get:
 *     summary: Get all currently active (in-progress) trips
 *     tags: [Super Admin - Monitoring]
 *     responses:
 *       200:
 *         description: List of active trips with driver and vehicle info
 */
router.get('/monitoring/active-trips', m.activeTrips);

/**
 * @swagger
 * /api/super-admin/monitoring/recent-trips:
 *   get:
 *     summary: Get recent trips across all schools
 *     tags: [Super Admin - Monitoring]
 *     parameters:
 *       - in: query
 *         name: schoolId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [scheduled, in_progress, completed, cancelled]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Paginated list of recent trips
 */
router.get('/monitoring/recent-trips', m.recentTrips);

/**
 * @swagger
 * /api/super-admin/monitoring/trip-history:
 *   get:
 *     summary: Get trip history with date range filtering
 *     tags: [Super Admin - Monitoring]
 *     parameters:
 *       - in: query
 *         name: schoolId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Trip history with status breakdown
 */
router.get('/monitoring/trip-history', m.tripHistory);

/**
 * @swagger
 * /api/super-admin/monitoring/growth:
 *   get:
 *     summary: Get platform growth metrics with period comparison
 *     tags: [Super Admin - Monitoring]
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Number of days to measure growth
 *     responses:
 *       200:
 *         description: Growth metrics with percentage changes
 */
router.get('/monitoring/growth', m.growthMetrics);

/**
 * @swagger
 * /api/super-admin/monitoring/school-growth:
 *   get:
 *     summary: Get per-school growth breakdown
 *     tags: [Super Admin - Monitoring]
 *     responses:
 *       200:
 *         description: Growth data per school
 */
router.get('/monitoring/school-growth', m.schoolGrowth);

/**
 * @swagger
 * /api/super-admin/monitoring/alerts:
 *   get:
 *     summary: Get platform health alerts
 *     tags: [Super Admin - Monitoring]
 *     responses:
 *       200:
 *         description: Alerts including idle schools, expired insurance, missing admins
 */
router.get('/monitoring/alerts', m.alerts);

/**
 * @swagger
 * /api/super-admin/monitoring/audit-logs:
 *   get:
 *     summary: Get audit logs (filterable)
 *     tags: [Super Admin - Monitoring]
 *     parameters:
 *       - in: query
 *         name: userId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: schoolId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Paginated audit logs
 */
router.get('/monitoring/audit-logs', m.auditLogs);

/**
 * @swagger
 * /api/super-admin/monitoring/recent-logins:
 *   get:
 *     summary: Get recent login activity
 *     tags: [Super Admin - Monitoring]
 *     parameters:
 *       - in: query
 *         name: schoolId
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Recent login attempts (success and failed)
 */
router.get('/monitoring/recent-logins', m.recentLogins);

/**
 * @swagger
 * /api/super-admin/monitoring/subscriptions:
 *   get:
 *     summary: List all school subscriptions
 *     tags: [Super Admin - Monitoring]
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, expired, cancelled, trial]
 *     responses:
 *       200:
 *         description: List of subscriptions
 */
router.get('/monitoring/subscriptions', m.subscriptions);

/**
 * @swagger
 * /api/super-admin/monitoring/subscriptions:
 *   post:
 *     summary: Create or update a school subscription
 *     tags: [Super Admin - Monitoring]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [schoolId, plan]
 *             properties:
 *               schoolId:
 *                 type: integer
 *               plan:
 *                 type: string
 *                 enum: [free, basic, premium, enterprise]
 *               maxStudents:
 *                 type: integer
 *               maxVehicles:
 *                 type: integer
 *               startDate:
 *                 type: string
 *                 format: date
 *               endDate:
 *                 type: string
 *                 format: date
 *               amount:
 *                 type: number
 *               currency:
 *                 type: string
 *     responses:
 *       201:
 *         description: Subscription created/updated
 */
router.post('/monitoring/subscriptions', m.createSubscription);

/**
 * @swagger
 * /api/super-admin/monitoring/usage:
 *   get:
 *     summary: Get usage metrics per school (students/vehicles vs limits)
 *     tags: [Super Admin - Monitoring]
 *     responses:
 *       200:
 *         description: Usage data with utilization percentages
 */
router.get('/monitoring/usage', m.schoolUsage);

module.exports = router;
