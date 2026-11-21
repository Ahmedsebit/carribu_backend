const { Server } = require('socket.io');
const { sendPushToUser } = require('./services/push');
const { getAuthenticatedUser } = require('./middleware/auth');
const { getAccessibleTrip } = require('./services/tripAccess');

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
  'student-dropped-off': 'Student Dropped Off',
  'trip-completed': 'Trip Completed',
  'trip-cancelled': 'Trip Cancelled',
  'new-message': '💬 New Message',
};

let io;
const tripDeliveries = new Map();

function initSocket(server) {
  // Load after socket exports are initialized; locationTracking emits through this module.
  const { recordDriverLocation } = require('./services/locationTracking');
  io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  // Auth middleware - verify JWT on connection
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('No token'));
    try {
      socket.user = await getAuthenticatedUser(token);
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
    if (schoolId && role !== 'parent') socket.join(`school:${schoolId}`);

    const joinTrip = async (tripId, acknowledge) => {
      try {
        socket.user = await getAuthenticatedUser(socket.handshake.auth?.token || socket.handshake.query?.token);
        const access = await getAccessibleTrip(tripId, socket.user);
        if (!access) throw Object.assign(new Error('Trip not found.'), { status: 404 });
        await socket.join(`trip:${access.trip.id}`);
        if (typeof acknowledge === 'function') acknowledge({ accepted: true, tripId: access.trip.id });
      } catch (err) {
        const result = { accepted: false, status: err.status || 403, error: 'Trip access denied.' };
        if (typeof acknowledge === 'function') acknowledge(result);
        else socket.emit('trip-access-error', result);
      }
    };
    socket.on('join-trip', joinTrip);
    socket.on('track-trip', joinTrip);

    // Driver sends location update
    socket.on('driver-location', async (data, acknowledge) => {
      try {
        socket.user = await getAuthenticatedUser(socket.handshake.auth?.token || socket.handshake.query?.token);
        const { location } = await recordDriverLocation(data || {}, socket.user);
        if (typeof acknowledge === 'function') acknowledge({ accepted: true, locationId: location.id, source: 'phone' });
      } catch (err) {
        const result = {
          status: err.status || 500,
          code: err.code || 'LOCATION_UPDATE_FAILED',
          error: err.status ? err.message : 'Unable to update trip location.',
        };
        console.error(`Driver location rejected for user ${id}: ${result.code} (${result.status}).`);
        if (typeof acknowledge === 'function') acknowledge(result);
        else socket.emit('location-error', result);
      }
    });

    // Chat messages
    socket.on('chat-message', async (data, acknowledge) => {
      let result;
      try {
        socket.user = await getAuthenticatedUser(socket.handshake.auth?.token || socket.handshake.query?.token);
        result = { accepted: false, status: 400, code: 'USE_MESSAGE_API', error: 'Send messages through the API so they can be authorised and saved.' };
      } catch (err) {
        result = { accepted: false, status: 401, code: 'SESSION_EXPIRED', error: 'Sign in again before sending messages.' };
      }
      if (typeof acknowledge === 'function') acknowledge(result);
      else socket.emit('chat-error', result);
    });
    socket.on('untrack-trip', tripId => {
      const value = Number(tripId);
      if (Number.isSafeInteger(value) && value > 0) socket.leave(`trip:${value}`);
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
async function notifyUser(userId, event, data) {
  await emitUser(userId, event, data);
  // Also deliver a phone tray push so parents/drivers are alerted when the
  // app is backgrounded or closed (socket Alerts only fire in the foreground).
  if (data && data.message && PUSH_TITLES[event]) {
    await sendPushToUser(userId, PUSH_TITLES[event], data.message, { event, ...data }).catch(() => {});
  }
}

async function emitUser(userId, event, data) {
  if (!io) return;
  const room = `user:${userId}`;
  try {
    const sockets = await io.in(room).fetchSockets();
    await Promise.all(sockets.map(async socket => {
      try {
        const user = await getAuthenticatedUser(socket.handshake.auth?.token || socket.handshake.query?.token);
        if (user.id !== Number(userId)) return;
        if (data?.schoolId) {
          if (user.role === 'parent') {
            if (!await require('./utils/parentSchoolAccess').hasActiveParentSchool(user.id, data.schoolId)) return;
          } else if (user.role !== 'super_admin' && user.schoolId !== data.schoolId) return;
        }
        if (data?.tripId && !await getAccessibleTrip(data.tripId, user)) return;
        socket.emit(event, data);
      } catch (err) {
        await socket.leave(room);
        socket.disconnect?.(true);
      }
    }));
  } catch (err) {
    console.error('Unable to authorize personal notification delivery.');
  }
}

// Emit to all users in a trip room
function notifyTrip(tripId, event, data) {
  const key = String(tripId);
  const previous = tripDeliveries.get(key) || Promise.resolve();
  const delivery = previous.then(() => deliverTrip(tripId, event, data));
  tripDeliveries.set(key, delivery);
  delivery.finally(() => {
    if (tripDeliveries.get(key) === delivery) tripDeliveries.delete(key);
  });
  return delivery;
}

async function deliverTrip(tripId, event, data) {
  if (!io) return;
  const room = `trip:${tripId}`;
  try {
    const sockets = await io.in(room).fetchSockets();
    await Promise.all(sockets.map(async socket => {
      try {
        // Revoked memberships and expired sessions must not retain previously joined rooms.
        const user = await getAuthenticatedUser(socket.handshake.auth?.token || socket.handshake.query?.token);
        if (!await getAccessibleTrip(tripId, user)) {
          await socket.leave(room);
          socket.emit('trip-access-error', { accepted: false, status: 403, error: 'Trip access denied.' });
          return;
        }
        socket.emit(event, data);
      } catch (err) {
        await socket.leave(room);
      }
    }));
  } catch (err) {
    console.error('Unable to authorize trip notification delivery.');
  }
}

module.exports = { initSocket, getIO, notifyUser, notifyTrip, emitUser, PUSH_TITLES };
