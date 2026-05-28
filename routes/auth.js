const router = require('express').Router();
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication & user profile
 */

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password, firstName, lastName, schoolId]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: parent@example.com
 *               password:
 *                 type: string
 *                 minLength: 6
 *                 example: secret123
 *               firstName:
 *                 type: string
 *                 example: Jane
 *               lastName:
 *                 type: string
 *                 example: Doe
 *               role:
 *                 type: string
 *                 enum: [admin, coordinator, driver, parent]
 *                 default: parent
 *               phone:
 *                 type: string
 *                 example: "+254700000000"
 *               schoolId:
 *                 type: integer
 *                 example: 1
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 token:
 *                   type: string
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       400:
 *         description: Email already registered or invalid school ID
 */
router.post('/register', authController.register);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Login and receive a JWT token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: admin@nairobiacademy.co.ke
 *               password:
 *                 type: string
 *                 example: admin123
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 token:
 *                   type: string
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       401:
 *         description: Invalid credentials
 *       403:
 *         description: Account deactivated
 */
router.post('/login', authController.login);

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Get current authenticated user profile
 *     tags: [Auth]
 *     responses:
 *       200:
 *         description: Current user info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *       404:
 *         description: User not found
 */
router.get('/me', authenticate, authController.getMe);

/**
 * @swagger
 * /api/auth/change-password:
 *   put:
 *     summary: Change current user password
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       200:
 *         description: Password changed successfully
 *       400:
 *         description: Missing fields or new password too short
 *       401:
 *         description: Current password incorrect
 */
router.put('/change-password', authenticate, authController.changePassword);

/**
 * @swagger
 * /api/auth/profile:
 *   put:
 *     summary: Update current user profile (phone, pickup location)
 *     tags: [Auth]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               phone:
 *                 type: string
 *               pickupAddress:
 *                 type: string
 *               pickupLat:
 *                 type: number
 *                 format: double
 *               pickupLng:
 *                 type: number
 *                 format: double
 *     responses:
 *       200:
 *         description: Profile updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 message:
 *                   type: string
 */
router.put('/profile', authenticate, authController.updateProfile);

module.exports = router;
