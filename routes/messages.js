const router = require('express').Router();
const c = require('../controllers/messageController');
const { authenticate, authorize, schoolTenancy } = require('../middleware/auth');

/**
 * @swagger
 * tags:
 *   name: Messages
 *   description: In-app messaging between drivers and parents
 */

router.use(authenticate); router.use(schoolTenancy);

/**
 * @swagger
 * /api/messages/conversations:
 *   get:
 *     summary: List conversations for the current user
 *     tags: [Messages]
 *     responses:
 *       200:
 *         description: List of conversations with latest message
 */
router.get('/conversations', c.getConversations);

/**
 * @swagger
 * /api/messages/unread-count:
 *   get:
 *     summary: Get unread message count
 *     tags: [Messages]
 *     responses:
 *       200:
 *         description: Unread count
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 unreadCount:
 *                   type: integer
 */
router.get('/unread-count', c.getUnreadCount);

/**
 * @swagger
 * /api/messages/notifications:
 *   get:
 *     summary: Get notifications for the current user
 *     tags: [Messages]
 *     responses:
 *       200:
 *         description: Notifications list
 */
router.get('/notifications', c.getNotifications);

/**
 * @swagger
 * /api/messages/my-drivers:
 *   get:
 *     summary: Get drivers associated with the parent's children routes
 *     tags: [Messages]
 *     responses:
 *       200:
 *         description: List of drivers
 */
router.get('/my-drivers', c.getMyDrivers);

/**
 * @swagger
 * /api/messages/thread/{partnerId}:
 *   get:
 *     summary: Get message thread with a specific user
 *     tags: [Messages]
 *     parameters:
 *       - in: path
 *         name: partnerId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Message thread
 */
router.get('/thread/:partnerId', c.getThread);

/**
 * @swagger
 * /api/messages/route-parents/{routeId}:
 *   get:
 *     summary: Get all parents on a specific route (for driver messaging)
 *     tags: [Messages]
 *     parameters:
 *       - in: path
 *         name: routeId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: List of parents on the route
 */
router.get('/route-parents/:routeId', c.getRouteParents);

/**
 * @swagger
 * /api/messages/trip-notification:
 *   post:
 *     summary: Send an alert to parents associated with selected trips
 *     tags: [Messages]
 *     responses:
 *       201:
 *         description: Notification created for each unique parent
 */
router.post('/trip-notification', authorize('school_admin', 'coordinator'), c.sendTripNotification);

/**
 * @swagger
 * /api/messages:
 *   post:
 *     summary: Send a message
 *     tags: [Messages]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [receiverId, content]
 *             properties:
 *               receiverId:
 *                 type: integer
 *               content:
 *                 type: string
 *               tripId:
 *                 type: integer
 *               type:
 *                 type: string
 *                 enum: [text, alert, absence]
 *     responses:
 *       201:
 *         description: Message sent
 */
router.post('/', c.send);

/**
 * @swagger
 * /api/messages/absence:
 *   post:
 *     summary: Report student absence (parent notifies driver)
 *     tags: [Messages]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [studentId]
 *             properties:
 *               studentId:
 *                 type: integer
 *               date:
 *                 type: string
 *                 format: date
 *               reason:
 *                 type: string
 *     responses:
 *       201:
 *         description: Absence reported
 */
router.post('/absence', c.reportAbsence);

module.exports = router;
