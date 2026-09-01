const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { User, Trip, Route, Student, RouteStudent } = require('./models');
const { sendPushToUser } = require('./services/push');

// Human-readable titles for the phone tray notification, keyed by socket event.
const PUSH_TITLES = {
  'trip-started': '🚌 Trip Started',
  'trip-reminder': '⏰ Trip Starting Soon',
  'trip-delayed': '⏱️ Trip Delayed',
  'school-notification': 'School Transport Update',
  'trip-missed': '⚠️ Trip Not Started',
  'driver-approaching': '🚌 Driver Approaching',
  'driver-arrived': '📍 Bus Arrived',
  'student-picked-up': '✅ Picked Up',
  'new-message': '💬 New Message',
};

let io;

function initSocket(server) {
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Auth middleware - verify JWT on connection
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('No token'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'school_transport_secret_key_2024');
      socket.user = decoded;
      next();
    } catch (e) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role, schoolId } = socket.user;
    console.log(`🔌 Socket connected: ${role} #${id}`);

    // Join personal room for direct notifications
    socket.join(`user:${id}`);
    socket.join(`school:${schoolId}`);

    // Driver joins trip room when they start driving
    socket.on('join-trip', (tripId) => {
      socket.join(`trip:${tripId}`);
      console.log(`🚌 User #${id} joined trip:${tripId}`);
    });

    // Parent joins trip room to track
    socket.on('track-trip', (tripId) => {
      socket.join(`trip:${tripId}`);
      console.log(`👀 Parent #${id} tracking trip:${tripId}`);
    });

    // Driver sends location update
    socket.on('driver-location', (data) => {
      // data: { tripId, lat, lng, speed, heading }
      const payload = { ...data, driverId: id, timestamp: Date.now() };
      // Broadcast to all tracking this trip
      io.to(`trip:${data.tripId}`).emit('location-update', payload);
    });

    // Chat messages
    socket.on('chat-message', async (data) => {
      // data: { tripId, receiverId, message }
      const payload = {
        senderId: id,
        senderName: `${socket.user.firstName || ''} ${socket.user.lastName || ''}`.trim() || 'User',
        senderRole: role,
        message: data.message,
        tripId: data.tripId,
        timestamp: Date.now(),
      };
      // Send to receiver and sender
      io.to(`user:${data.receiverId}`).emit('new-message', payload);
      io.to(`user:${id}`).emit('new-message', payload);
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${role} #${id}`);
    });
  });

  return io;
}

function getIO() {
  if (!io) throw new Error('Socket.IO not initialized');
  return io;
}

// Emit notification to specific user
function notifyUser(userId, event, data) {
  if (io) io.to(`user:${userId}`).emit(event, data);
  // Also deliver a phone tray push so parents/drivers are alerted when the
  // app is backgrounded or closed (socket Alerts only fire in the foreground).
  if (data && data.message && PUSH_TITLES[event]) {
    sendPushToUser(userId, PUSH_TITLES[event], data.message, { event, ...data }).catch(() => {});
  }
}

// Emit to all users in a trip room
function notifyTrip(tripId, event, data) {
  if (io) io.to(`trip:${tripId}`).emit(event, data);
}

module.exports = { initSocket, getIO, notifyUser, notifyTrip };
