const request = require('supertest');
const jwt = require('jsonwebtoken');
const { io: connectSocket } = require('socket.io-client');

jest.mock('../../services/push', () => ({
  sendPushToUser: jest.fn(async () => {}),
  deliverOutboxPush: jest.fn(async () => ({ synthetic: { status: 'accepted' } })),
}));
jest.mock('../../utils/email', () => ({
  sendWelcomeEmail: jest.fn(async () => ({ sent: false })),
  sendPasswordResetEmail: jest.fn(async () => ({ sent: false })),
}));

const models = require('../../models');
const { sequelize, User, School, Trip, Message, ParentActivationInvitation, ParentSchool, NotificationOutbox, RouteStudent } = models;
const { app, server, io } = require('../../server');
const { runMigrations, migrator } = require('../../config/migrator');
const { processNotificationOutbox } = require('../../services/notificationOutbox');
const { deliverOutboxPush } = require('../../services/push');
const { schoolDate, checkDelayedTrips, checkMissedTrips } = require('../../services/tripReminders');
const { emitUser } = require('../../socket');

let baseUrl, rootToken, fixture, sequence = 0;
const sockets = [];
const api = async (method, path, token, body, status = 200) => {
  let call = request(baseUrl)[method](`/api${path}`);
  if (token) call = call.set('Authorization', `Bearer ${token}`);
  if (body) call = call.send(body);
  const result = await call;
  expect({ status: result.status, error: result.body.error }).toEqual({
    status, error: status >= 400 ? expect.any(String) : undefined,
  });
  return result.body;
};
const login = async (email, password = 'simulation123') =>
  (await api('post', '/auth/login', null, { email, password })).token;
const invitation = async parent => (await api('post', `/parents/${parent.id}/activation-invitation`,
  fixture.adminToken, {}, 201)).code;
const activate = (parent, code, status = 200) => api('post', '/auth/complete-registration', null, {
  phone: parent.phone, invitationCode: code, newPassword: 'simulation123',
}, status);
const futureDate = days => schoolDate(Date.now() + days * 86400000);
const currentTime = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(11, 16);
const trip = async (type = 'morning_pickup', options = {}) => (await api('post', '/trips', fixture.adminToken, {
  routeId: fixture.route.id, type, scheduledDate: schoolDate(), scheduledTime: currentTime(), ...options,
}, 201)).trip;
const start = id => api('put', `/trips/${id}/start`, fixture.driverToken, {});
const action = (id, student, value, token = fixture.driverToken, options = {}, status = 201) =>
  api('post', `/trips/${id}/log`, token, {
    studentId: student.id, action: value, phase: value === 'check_out' ? 'dropoff' : 'pickup', ...options,
  }, status);
const socketFor = async token => {
  const socket = connectSocket(baseUrl, { auth: { token }, transports: ['websocket'], reconnection: false });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
};
const ack = (socket, event, payload) => new Promise((resolve, reject) =>
  socket.timeout(3000).emit(event, payload, (error, response) => error ? reject(error) : resolve(response)));
const received = (socket, event) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Missing ${event}`)), 3000);
  socket.once(event, value => { clearTimeout(timeout); resolve(value); });
});

beforeAll(async () => {
  if (process.env.CARRIBU_ISOLATED_E2E !== '1' || process.env.DB_HOST !== '127.0.0.1'
    || process.env.DB_PORT !== '56439' || process.env.DB_NAME !== 'carribu_workflow_launch_e2e') {
    throw new Error('Launch journeys require the explicitly isolated launch database.');
  }
  await sequelize.authenticate();
  await sequelize.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations();
  expect(await migrator.pending()).toHaveLength(0);
  expect(await migrator.executed()).toHaveLength(20);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await api('get', '/health');
  const root = await User.create({
    email: 'launch-root@example.test', firstName: 'Synthetic', lastName: 'Operator',
    passwordHash: 'simulation123', role: 'super_admin',
  });
  rootToken = await login(root.email);
}, 60000);

beforeEach(async () => {
  deliverOutboxPush.mockReset();
  deliverOutboxPush.mockResolvedValue({ synthetic: { status: 'accepted' } });
  await NotificationOutbox.update({ status: 'cancelled' }, { where: {} });
  sequence += 1;
  const school = (await api('post', '/schools', rootToken, {
    name: `Launch simulation ${sequence}`, address: 'Synthetic school', city: 'Nairobi',
  }, 201)).school;
  const admin = await User.create({
    schoolId: school.id, email: `staff-${sequence}@example.test`, firstName: 'Synthetic',
    lastName: 'Administrator', passwordHash: 'simulation123', role: 'school_admin',
  });
  fixture = { school, admin, adminToken: await login(admin.email) };
  const createdDriver = await api('post', '/drivers', fixture.adminToken, {
    email: `driver-${sequence}@example.test`, firstName: 'Synthetic', lastName: 'Driver',
    password: 'simulation123', phone: `+254711${String(sequence).padStart(6, '0')}`,
  }, 201);
  const driver = createdDriver.driver;
  fixture.driver = driver;
  fixture.driverToken = await login(driver.email, createdDriver.tempPassword);
  fixture.parents = [];
  fixture.students = [];
  for (let child = 0; child < 2; child += 1) {
    const parent = (await api('post', '/parents', fixture.adminToken, {
      email: `parent-${sequence}-${child}@example.test`, firstName: 'Synthetic', lastName: `Parent ${child}`,
      phone: `+254712${String(sequence * 10 + child).padStart(6, '0')}`,
      pickupAddress: `Synthetic stop ${child}`, pickupLat: -1.26 - child * 0.01, pickupLng: 36.8,
    }, 201)).parent;
    parent.token = (await activate(parent, await invitation(parent))).token;
    fixture.parents.push(parent);
    fixture.students.push((await api('post', '/students', fixture.adminToken, {
      admissionNumber: `LAUNCH-${sequence}-${child}`, firstName: 'Synthetic', lastName: `Child ${child}`,
      grade: 'Grade 3', parentId: parent.id,
    }, 201)).student);
  }
  fixture.vehicle = (await api('post', '/vehicles', fixture.adminToken, {
    plateNumber: `SIM-${sequence}`, capacity: 2, status: 'active',
  }, 201)).vehicle;
  fixture.route = (await api('post', '/routes', fixture.adminToken, {
    name: `Simulation route ${sequence}`, type: 'both', driverId: driver.id, vehicleId: fixture.vehicle.id,
    studentIds: fixture.students.map(student => student.id),
    outboundWaypoints: [{ lat: -1.26, lng: 36.8, label: 'Start' }, { lat: -1.3, lng: 36.82, label: 'School' }],
  }, 201)).route;
}, 30000);

afterEach(() => { for (const socket of sockets.splice(0)) socket.disconnect(); });
afterAll(async () => {
  for (const socket of sockets.splice(0)) socket.disconnect();
  await new Promise(resolve => io.close(resolve));
  await sequelize.close();
});

test('provisioning produces real school-scoped resources and current contacts', async () => {
  const dashboard = await api('get', `/schools/${fixture.school.id}/dashboard`, fixture.adminToken);
  expect(dashboard.dashboard).toMatchObject({ studentCount: 2, vehicleCount: 1, routeCount: 1, driverCount: 1 });
  expect((await api('get', '/students', fixture.parents[0].token)).students.map(row => row.id))
    .toEqual([fixture.students[0].id]);
  const contacts = await api('get', '/messages/my-drivers', fixture.parents[0].token);
  expect(contacts.drivers.map(row => row.id)).toContain(fixture.driver.id);
});

test('public signup cannot provision staff, join a school or bypass activation', async () => {
  const body = { email: 'public-launch@example.test', password: 'simulation123', firstName: 'Synthetic', lastName: 'Public' };
  await api('post', '/auth/register', null, { ...body, role: 'school_admin' }, 403);
  await api('post', '/auth/register', null, { ...body, schoolId: fixture.school.id }, 403);
  const registration = await api('post', '/auth/register', null, body, 201);
  expect(registration.token).toBeUndefined();
  expect(registration.user.mustSetPassword).toBe(true);
  await api('post', '/auth/login', null, { email: body.email, password: body.password }, 403);
});

test('expired, regenerated, wrong-phone and consumed invitations reject; activation invalidates old tokens', async () => {
  const parent = (await api('post', '/parents', fixture.adminToken, {
    email: 'invitation-launch@example.test', firstName: 'Synthetic', lastName: 'Pending',
    phone: '+254713000001',
  }, 201)).parent;
  const expired = await invitation(parent);
  await ParentActivationInvitation.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { parentId: parent.id } });
  await activate(parent, expired, 403);
  const previous = await invitation(parent);
  const current = await invitation(parent);
  await activate(parent, previous, 403);
  await activate({ ...parent, phone: fixture.parents[0].phone }, current, 403);
  const stale = jwt.sign({ id: parent.id, authVersion: 0 }, process.env.JWT_SECRET);
  await api('get', '/auth/me', stale, null, 401);
  const activated = await activate(parent, current);
  await api('get', '/auth/me', activated.token);
  await api('get', '/auth/me', stale, null, 401);
  await activate(parent, current, 403);
  await api('post', `/parents/${parent.id}/activation-invitation`, fixture.adminToken, {}, 409);
});

test('simultaneous activation consumes an invitation exactly once', async () => {
  const parent = (await api('post', '/parents', fixture.adminToken, {
    email: 'concurrent-activation@example.test', firstName: 'Synthetic', lastName: 'Concurrent', phone: '+254713000002',
  }, 201)).parent;
  const code = await invitation(parent);
  const results = await Promise.all([0, 1].map(() => request(baseUrl).post('/api/auth/complete-registration')
    .send({ phone: parent.phone, invitationCode: code, newPassword: 'simulation123' })));
  expect(results.map(result => result.status).sort()).toEqual([200, 403]);
  expect((await User.findByPk(parent.id)).authVersion).toBe(1);
});

test('school and role boundaries hold through details, updates, logs, contacts and sockets', async () => {
  const foreignSchool = await School.create({ name: 'Synthetic foreign school' });
  const foreignAdmin = await User.create({
    schoolId: foreignSchool.id, email: 'foreign-launch@example.test', firstName: 'Synthetic',
    lastName: 'Foreign', role: 'school_admin', passwordHash: 'simulation123',
  });
  const foreignToken = await login(foreignAdmin.email);
  const scheduled = await trip();
  for (const path of [`/schools/${fixture.school.id}`, `/students/${fixture.students[0].id}`,
    `/trips/${scheduled.id}/details`, `/trips/${scheduled.id}/logs`, `/parents/${fixture.parents[0].id}`]) {
    await api('get', path, foreignToken, null, 404);
  }
  await api('put', `/schools/${fixture.school.id}`, foreignToken, { name: 'Foreign edit' }, 404);
  await api('put', `/vehicles/${fixture.vehicle.id}`, fixture.adminToken, { schoolId: foreignSchool.id }, 400);
  expect((await models.Vehicle.findByPk(fixture.vehicle.id)).schoolId).toBe(fixture.school.id);
  await api('post', '/messages', fixture.parents[0].token, { receiverId: foreignAdmin.id, content: 'Denied' }, 404);
  await api('post', '/vehicles', fixture.parents[0].token, { plateNumber: 'FORBIDDEN', capacity: 3 }, 403);
  const socket = await socketFor(foreignToken);
  expect(await ack(socket, 'track-trip', scheduled.id)).toMatchObject({ accepted: false, status: 404 });
});

test('scheduling validates capacity, coordinates, availability and duplicate resources before departure', async () => {
  await api('post', '/trips', fixture.adminToken, {
    routeId: fixture.route.id, type: 'morning_pickup', scheduledDate: futureDate(1),
  }, 400);
  await api('put', `/vehicles/${fixture.vehicle.id}`, fixture.adminToken, { capacity: 1 });
  await api('post', '/trips', fixture.adminToken, {
    routeId: fixture.route.id, type: 'morning_pickup', scheduledDate: futureDate(1), scheduledTime: '08:00',
  }, 409);
  await api('put', `/vehicles/${fixture.vehicle.id}`, fixture.adminToken, { capacity: 2, status: 'maintenance' });
  await api('post', '/trips', fixture.adminToken, {
    routeId: fixture.route.id, type: 'morning_pickup', scheduledDate: futureDate(1), scheduledTime: '08:00',
  }, 409);
  await api('put', `/vehicles/${fixture.vehicle.id}`, fixture.adminToken, { status: 'active' });
  await trip('morning_pickup', { scheduledDate: futureDate(1), scheduledTime: '08:00' });
  await api('post', '/trips', fixture.adminToken, {
    routeId: fixture.route.id, type: 'morning_pickup', scheduledDate: futureDate(1), scheduledTime: '08:00',
  }, 409);
});

test('future legacy untimed journeys cannot start and departures outside the start window reject', async () => {
  const untimed = await Trip.create({
    routeId: fixture.route.id, driverId: fixture.driver.id, vehicleId: fixture.vehicle.id,
    type: 'morning_pickup', scheduledDate: futureDate(1),
  });
  await api('put', `/trips/${untimed.id}/start`, fixture.driverToken, {}, 400);
  const tomorrow = await trip('afternoon_dropoff', { scheduledDate: futureDate(1), scheduledTime: '08:00' });
  await api('put', `/trips/${tomorrow.id}/start`, fixture.driverToken, {}, 400);
});

test('morning journey joins real rooms, reports GPS, reconciles absence and completes with frozen history', async () => {
  const scheduled = await trip();
  const parent = await socketFor(fixture.parents[0].token);
  const driver = await socketFor(fixture.driverToken);
  expect(await ack(parent, 'track-trip', scheduled.id)).toMatchObject({ accepted: true });
  await start(scheduled.id);
  const fix = await ack(driver, 'driver-location', { tripId: scheduled.id, lat: -1.26, lng: 36.8, speed: 0 });
  expect(fix.accepted).toBe(true);
  const bus = await api('get', '/location/my-bus', fixture.parents[0].token);
  expect(bus.activeBuses.map(value => value.tripId || value.trip?.id)).toContain(scheduled.id);
  await api('put', `/trips/${scheduled.id}/end`, fixture.driverToken, {}, 409);
  await action(scheduled.id, fixture.students[0], 'arrived');
  await action(scheduled.id, fixture.students[0], 'check_in', fixture.driverToken, { idempotencyKey: 'launch-boarding' });
  await action(scheduled.id, fixture.students[0], 'check_in', fixture.driverToken, { idempotencyKey: 'launch-boarding' }, 200);
  await api('put', `/trips/${scheduled.id}/cancel`, fixture.adminToken, {}, 409);
  const absence = await api('post', '/messages/absence', fixture.parents[1].token,
    { studentId: fixture.students[1].id, reason: 'Synthetic absence' }, 201);
  expect(absence.requests[0].date).toBe(schoolDate());
  await api('post', `/absences/${absence.requests[0].id}/confirm`, fixture.adminToken,
    { tripId: scheduled.id, notes: 'Verified with synthetic guardian' });
  await action(scheduled.id, fixture.students[0], 'arrived', fixture.driverToken, { phase: 'dropoff' });
  await action(scheduled.id, fixture.students[0], 'check_out', fixture.adminToken, { notes: 'School verified safe arrival' });
  await api('put', `/trips/${scheduled.id}/end`, fixture.driverToken, {});
  await api('put', `/routes/${fixture.route.id}`, fixture.adminToken, { studentIds: [] });
  const history = await api('get', '/parent/trip-history', fixture.parents[0].token);
  expect(history.trips.find(row => row.id === scheduled.id).children).toEqual([
    expect.objectContaining({ studentId: fixture.students[0].id, status: 'dropped_off' }),
  ]);
  const staffHistory = await api('get', `/routes/${fixture.route.id}/trip-history`, fixture.adminToken);
  expect(staffHistory.trips.find(row => row.id === scheduled.id).attendance)
    .toMatchObject({ expected: 2, boarded: 1, droppedOff: 1, absent: 1, notBoarded: 0 });
});

test('afternoon journey requires boarding, keeps children onboard at arrival and drops them off safely', async () => {
  const scheduled = await trip('afternoon_dropoff');
  await start(scheduled.id);
  await action(scheduled.id, fixture.students[0], 'check_out', fixture.driverToken, {}, 409);
  await action(scheduled.id, fixture.students[0], 'check_in');
  await action(scheduled.id, fixture.students[1], 'absent');
  const arrived = await action(scheduled.id, fixture.students[0], 'arrived', fixture.driverToken, { phase: 'dropoff' });
  expect(arrived.stats.onBus).toBe(1);
  await api('put', `/trips/${scheduled.id}/end`, fixture.driverToken, {}, 409);
  await action(scheduled.id, fixture.students[0], 'check_out');
  expect((await api('put', `/trips/${scheduled.id}/end`, fixture.driverToken, {})).trip.status).toBe('completed');
});

test('active-trip guards prevent student, route and vehicle lifecycle changes', async () => {
  const scheduled = await trip();
  await start(scheduled.id);
  await api('delete', `/students/${fixture.students[0].id}`, fixture.adminToken, null, 409);
  await api('put', `/routes/${fixture.route.id}`, fixture.adminToken, { studentIds: [] }, 409);
  await api('delete', `/vehicles/${fixture.vehicle.id}`, fixture.adminToken, null, 409);
  await api('put', `/vehicles/${fixture.vehicle.id}`, fixture.adminToken, { capacity: 1 }, 409);
  await api('put', `/vehicles/${fixture.vehicle.id}`, fixture.adminToken, { status: 'maintenance' }, 409);
});

test('deactivated students are excluded from future frozen plans and can be reactivated', async () => {
  const scheduled = await trip('morning_pickup', { scheduledDate: futureDate(1), scheduledTime: '08:00' });
  await api('delete', `/students/${fixture.students[1].id}`, fixture.adminToken);
  expect((await Trip.findByPk(scheduled.id)).plan.stops.map(row => row.studentId)).toEqual([fixture.students[0].id]);
  await api('put', `/students/${fixture.students[1].id}`, fixture.adminToken, { isActive: true });
  expect((await Trip.findByPk(scheduled.id)).plan.stops).toHaveLength(2);
});

test('cancelled trips remain visible without GPS or current route membership', async () => {
  const scheduled = await trip();
  await start(scheduled.id);
  await api('put', `/trips/${scheduled.id}/cancel`, fixture.driverToken, {}, 403);
  await api('put', `/trips/${scheduled.id}/cancel`, fixture.adminToken, {});
  await api('put', `/routes/${fixture.route.id}`, fixture.adminToken, { studentIds: [] });
  const upcoming = await api('get', '/parent/upcoming-trips?includeDisruptions=true', fixture.parents[0].token);
  expect(upcoming.trips.find(row => row.id === scheduled.id).status).toBe('cancelled');
  const history = await api('get', '/parent/trip-history', fixture.parents[0].token);
  expect(history.trips.find(row => row.id === scheduled.id).status).toBe('cancelled');
});

test('delay then missed-trip processing persists visible disruptions and suppresses resolved notices', async () => {
  const scheduled = await trip();
  const instant = require('../../services/tripReminders').tripStartMs(scheduled);
  await checkDelayedTrips(instant + 5 * 60000);
  expect((await Trip.findByPk(scheduled.id)).status).toBe('delayed');
  await checkMissedTrips(instant + 21 * 60000);
  expect((await Trip.findByPk(scheduled.id)).status).toBe('missed');
  const upcoming = await api('get', '/parent/upcoming-trips?includeDisruptions=true', fixture.parents[0].token);
  expect(upcoming.trips.find(row => row.id === scheduled.id).status).toBe('missed');
  await processNotificationOutbox();
  const old = await NotificationOutbox.findAll({ where: { tripId: scheduled.id, event: 'trip-delayed' } });
  expect(old.map(row => row.status)).toEqual(['cancelled', 'cancelled']);
  await api('put', `/trips/${scheduled.id}/start`, fixture.driverToken, {}, 400);
});

test('text permissions reject parent peers, forged system notices and unowned absences', async () => {
  await api('post', '/messages', fixture.parents[0].token,
    { receiverId: fixture.parents[1].id, content: 'Denied' }, 404);
  await api('post', '/messages', fixture.parents[0].token,
    { receiverId: fixture.driver.id, content: 'Denied', messageType: 'system' }, 400);
  await api('post', '/messages/absence', fixture.parents[0].token,
    { studentId: fixture.students[1].id }, 404);
  await api('post', '/messages', fixture.parents[0].token,
    { receiverId: fixture.driver.id, content: 'Allowed office/driver contact' }, 201);
  await api('post', '/messages', fixture.parents[0].token,
    { receiverId: fixture.admin.id, content: 'Allowed school contact' }, 201);
});

test('concurrent HTTP retries save one message and one durable event, with socket delivery after persistence', async () => {
  const parent = await socketFor(fixture.parents[0].token);
  const nextMessage = received(parent, 'new-message');
  const input = { receiverId: fixture.parents[0].id, content: 'Synthetic concurrent message', clientMessageId: 'launch-message-001' };
  const results = await Promise.all([0, 1].map(() => request(baseUrl).post('/api/messages')
    .set('Authorization', `Bearer ${fixture.driverToken}`).send(input)));
  expect(results.map(result => result.status).sort()).toEqual([200, 201]);
  expect(new Set(results.map(result => result.body.message.id)).size).toBe(1);
  expect(await Message.count({ where: { senderId: fixture.driver.id, clientMessageId: input.clientMessageId } })).toBe(1);
  await processNotificationOutbox();
  expect((await nextMessage).id).toBe(results[0].body.message.id);
  expect(await NotificationOutbox.count({ where: { messageId: results[0].body.message.id } })).toBe(1);
  await api('post', '/messages', fixture.driverToken, { ...input, content: 'Different payload' }, 409);
});

test('threads page newest messages, mark only displayed rows read and delete only the caller copy', async () => {
  await Message.bulkCreate(Array.from({ length: 55 }, (_, index) => ({
    schoolId: fixture.school.id, senderId: fixture.driver.id, receiverId: fixture.parents[0].id,
    content: `Synthetic pagination ${index}`, messageType: 'text',
  })));
  const latest = await api('get', `/messages/thread/${fixture.driver.id}`, fixture.parents[0].token);
  expect(latest.messages).toHaveLength(50);
  expect(latest.hasMore).toBe(true);
  expect(await Message.count({ where: { receiverId: fixture.parents[0].id, isRead: false } })).toBe(5);
  const older = await api('get', `/messages/thread/${fixture.driver.id}?beforeId=${latest.messages[0].id}`, fixture.parents[0].token);
  expect(older.messages).toHaveLength(5);
  await api('delete', `/messages/thread/${fixture.driver.id}`, fixture.parents[0].token);
  expect((await api('get', `/messages/thread/${fixture.driver.id}`, fixture.parents[0].token)).messages).toHaveLength(0);
  expect((await api('get', `/messages/thread/${fixture.parents[0].id}`, fixture.driverToken)).messages).toHaveLength(50);
});

test('outbox retries retain stable event identity and cancel delivery after membership revocation', async () => {
  const sent = await api('post', '/messages', fixture.driverToken, {
    receiverId: fixture.parents[0].id, content: 'Synthetic retry', clientMessageId: 'launch-retry-001',
  }, 201);
  deliverOutboxPush.mockResolvedValueOnce({ synthetic: { status: 'retrying', error: 'SYNTHETIC_UNAVAILABLE' } });
  await processNotificationOutbox();
  const row = await NotificationOutbox.findOne({ where: { messageId: sent.message.id } });
  expect(row.status).toBe('retrying');
  await row.update({ nextAttemptAt: new Date(Date.now() - 1000) });
  await processNotificationOutbox();
  expect((await row.reload()).status).toBe('accepted');
  const revoked = await api('post', '/messages', fixture.driverToken,
    { receiverId: fixture.parents[1].id, content: 'Synthetic revoked delivery' }, 201);
  await ParentSchool.update({ isActive: false }, { where: { parentId: fixture.parents[1].id, schoolId: fixture.school.id } });
  await processNotificationOutbox();
  expect((await NotificationOutbox.findOne({ where: { messageId: revoked.message.id } })).status).toBe('cancelled');
});

test('broadcasts use frozen participation and exclude newly reassigned parents', async () => {
  const scheduled = await trip();
  await start(scheduled.id);
  await action(scheduled.id, fixture.students[0], 'absent');
  await action(scheduled.id, fixture.students[1], 'absent');
  await api('put', `/trips/${scheduled.id}/end`, fixture.driverToken, {});
  await api('put', `/students/${fixture.students[1].id}`, fixture.adminToken, { parentId: fixture.parents[0].id });
  const broadcast = await api('post', '/messages/trip-notification', fixture.adminToken,
    { tripIds: [scheduled.id], content: 'Synthetic school update' }, 201);
  expect(broadcast.recipientCount).toBe(1);
});

test('shared-device registration belongs to the current account and stale HTTP/socket sessions are rejected', async () => {
  const old = fixture.parents[0];
  const socket = await socketFor(old.token);
  await api('put', '/auth/push-token', old.token, { pushToken: 'ExpoPushToken[synthetic-shared-device]' });
  await api('put', '/auth/push-token', fixture.parents[1].token, { pushToken: 'ExpoPushToken[synthetic-shared-device]' });
  expect((await User.findByPk(old.id)).expoPushToken).toBeNull();
  await User.increment('authVersion', { where: { id: old.id } });
  await api('get', '/auth/me', old.token, null, 401);
  const disconnected = new Promise(resolve => socket.once('disconnect', resolve));
  await emitUser(old.id, 'new-message', { schoolId: fixture.school.id, message: 'Must not reach stale account' });
  await disconnected;
  expect(socket.connected).toBe(false);
});

test('raw socket chat cannot bypass saved-message delivery and leaving a trip removes its subscription', async () => {
  const scheduled = await trip();
  const socket = await socketFor(fixture.parents[0].token);
  expect(await ack(socket, 'track-trip', scheduled.id)).toMatchObject({ accepted: true });
  expect(await ack(socket, 'chat-message', { receiverId: fixture.driver.id, content: 'Unsaved' }))
    .toMatchObject({ accepted: false, code: 'USE_MESSAGE_API' });
  expect(await Message.count({ where: { senderId: fixture.parents[0].id } })).toBe(0);
  socket.emit('untrack-trip', scheduled.id);
  await ack(socket, 'chat-message', {});
  expect(io.sockets.sockets.get(socket.id).rooms.has(`trip:${scheduled.id}`)).toBe(false);
});
