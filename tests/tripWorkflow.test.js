jest.mock('../socket', () => ({ notifyTrip: jest.fn(), emitUser: jest.fn(), PUSH_TITLES: {} }));
const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, getTestData } = require('./setup');
const { sequelize, Trip, TripLog, Route, RouteStudent, RouteWaypoint, User, Vehicle, NotificationOutbox, Message, BusLocation } = require('../models');
const { startTrip, logStudentAction, completeTrip } = require('../services/tripWorkflow');
const { recordLocation } = require('../services/locationTracking');
const { notifyTrip } = require('../socket');

let data, actor, admin, driverToken, parentToken, otherDriver, otherVehicle;
beforeAll(async () => {
  if (!/^carribu_workflow_[a-z0-9_]+$/.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1') {
    throw new Error('Workflow integration tests require an explicitly isolated local carribu_workflow_* database.');
  }
  data = await setupTestDB();
  actor = { id: data.driver.id, schoolId: data.school.id, role: 'driver' };
  const login = await request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'admin123' });
  admin = login.body.token;
  const driverLogin = await request(app).post('/api/auth/login').send({ email: 'driver@test.com', password: 'driver123' });
  driverToken = driverLogin.body.token;
  const parentLogin = await request(app).post('/api/auth/login').send({ email: 'parent@test.com', password: 'parent123' });
  parentToken = parentLogin.body.token;
  otherDriver = await User.create({
    schoolId: data.school.id, role: 'driver', email: 'other-driver@test.com',
    passwordHash: 'driver123', firstName: 'Other', lastName: 'Driver',
  });
  otherVehicle = await Vehicle.create({ schoolId: data.school.id, plateNumber: 'OTHER-TEST', capacity: 18, status: 'active' });
});
afterAll(async () => sequelize.close());
beforeEach(async () => {
  jest.restoreAllMocks();
  notifyTrip.mockClear();
  await NotificationOutbox.destroy({ where: {} });
  await Message.destroy({ where: {} });
  await TripLog.destroy({ where: {} });
  await Trip.destroy({ where: {} });
  await data.vehicle.update({ trackerUniqueId: null });
  await data.parent.update({ pickupLat: -1.2641, dropoffLat: null, dropoffLng: null });
  await RouteStudent.findOrCreate({ where: { routeId: data.route.id, studentId: data.student2.id }, defaults: { stopOrder: 2 } });
});
const create = (type = 'morning_pickup', extra = {}) => Trip.create({
  routeId: data.route.id, driverId: data.driver.id, vehicleId: data.vehicle.id,
  type, scheduledDate: '2026-10-30', ...extra,
});
const act = (id, studentId, action, phase = action === 'check_out' ? 'dropoff' : 'pickup', extra = {}) =>
  logStudentAction(id, actor, { studentId, action, phase, ...extra });

test('morning lifecycle freezes the plan, holds arrival, and blocks unsafe completion for every role', async () => {
  const trip = await create();
  const started = await startTrip(trip.id, actor);
  expect(started.currentStop.studentId).toBe(data.student1.id);
  expect(await NotificationOutbox.count()).toBe(2);
  await expect(completeTrip(trip.id, actor)).rejects.toMatchObject({ status: 409 });
  await expect(completeTrip(trip.id, { schoolId: data.school.id, role: 'super_admin' })).rejects.toMatchObject({ status: 409 });
  await act(trip.id, data.student1.id, 'arrived');
  const boarded = await act(trip.id, data.student1.id, 'check_in');
  expect(boarded.phase).toBe('pickup');
  await expect(act(trip.id, data.student1.id, 'check_out')).rejects.toMatchObject({ status: 409 });
  const absence = await act(trip.id, data.student2.id, 'absent');
  expect(absence.currentStop).toMatchObject({ address: 'School', lat: -1.3, phase: 'dropoff' });
  await act(trip.id, data.student1.id, 'arrived', 'dropoff');
  await act(trip.id, data.student1.id, 'check_out');
  const completed = await completeTrip(trip.id, actor);
  expect(completed.trip.status).toBe('completed');
  expect(await NotificationOutbox.count({ where: { event: 'student-dropped-off' } })).toBe(1);
  expect(await NotificationOutbox.count({ where: { event: 'trip-completed' } })).toBe(2);
});

test('afternoon requires school boarding and preserves Drop Off after arrival', async () => {
  const trip = await create('afternoon_dropoff');
  expect((await startTrip(trip.id, actor)).phase).toBe('boarding');
  await act(trip.id, data.student1.id, 'check_in');
  const state = await act(trip.id, data.student2.id, 'absent');
  expect(state.phase).toBe('dropoff');
  const arrived = await act(trip.id, data.student1.id, 'arrived', 'dropoff');
  expect(arrived.currentStop.status).toBe('arrived_dropoff');
  expect(arrived.stats.onBus).toBe(1);
  await act(trip.id, data.student1.id, 'check_out');
  expect((await completeTrip(trip.id, actor)).canEnd).toBe(true);
});

test('concurrent retries produce one log, one message, and one outbox event', async () => {
  const trip = await create();
  await startTrip(trip.id, actor);
  const input = { studentId: data.student1.id, action: 'check_in', phase: 'pickup', idempotencyKey: 'boarding-1' };
  const results = await Promise.all([logStudentAction(trip.id, actor, input), logStudentAction(trip.id, actor, input)]);
  expect(results.filter(result => result.duplicate)).toHaveLength(1);
  expect(await TripLog.count({ where: { tripId: trip.id } })).toBe(1);
  expect(await NotificationOutbox.count({ where: { event: 'student-picked-up' } })).toBe(1);
  await expect(logStudentAction(trip.id, actor, { ...input, action: 'absent' })).rejects.toMatchObject({ status: 409 });
});

test('rejects wrong-school, unassigned driver, invalid student and inactive-trip actions', async () => {
  const trip = await create();
  await expect(startTrip(trip.id, { ...actor, schoolId: 9999 })).rejects.toMatchObject({ status: 404 });
  await expect(startTrip(trip.id, { ...actor, id: data.parent.id })).rejects.toMatchObject({ status: 403 });
  await expect(act(trip.id, data.student1.id, 'check_in')).rejects.toMatchObject({ status: 409 });
  await startTrip(trip.id, actor);
  await expect(act(trip.id, 9999, 'check_in')).rejects.toMatchObject({ status: 404 });
  await expect(act(trip.id, data.student1.id, 'check_out')).rejects.toMatchObject({ status: 409 });
});

test('freezes coordinates against later parent edits', async () => {
  const trip = await create();
  const first = await startTrip(trip.id, actor);
  const old = first.currentStop.lat;
  await data.parent.update({ pickupLat: -2 });
  const response = await request(app).get(`/api/trips/${trip.id}/details`).set('Authorization', `Bearer ${admin}`);
  expect(response.status).toBe(200);
  expect(response.body.trip.currentStop.lat).toBe(old);
  await data.parent.update({ pickupLat: -1.2641 });
});

test.each(['driver', 'vehicle'])('concurrent starts cannot share a %s with disjoint rosters and the other resource distinct', async resource => {
  await RouteStudent.destroy({ where: { routeId: data.route.id, studentId: data.student2.id } });
  const driverId = resource === 'driver' ? data.driver.id : otherDriver.id;
  const vehicleId = resource === 'vehicle' ? data.vehicle.id : otherVehicle.id;
  const route = await Route.create({ schoolId: data.school.id, name: `Other ${resource}`, driverId, vehicleId });
  await RouteStudent.create({ routeId: route.id, studentId: data.student2.id, stopOrder: 1 });
  await RouteWaypoint.create({ routeId: route.id, leg: 'outbound', orderIndex: 0, lat: -1.3, lng: 36.82 });
  const a = await create(), b = await create('afternoon_dropoff', { routeId: route.id, driverId, vehicleId });
  const adminActor = { id: data.admin.id, schoolId: data.school.id, role: 'school_admin' };
  const results = await Promise.allSettled([startTrip(a.id, adminActor), startTrip(b.id, adminActor)]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected').reason.status).toBe(409);
  expect(await Trip.count({ where: { status: 'in_progress' } })).toBe(1);
});

test('afternoon driver guidance, admin details and parent ETA use the same frozen drop-off', async () => {
  await data.parent.update({ dropoffLat: -1.31, dropoffLng: 36.83, dropoffAddress: 'Approved drop-off' });
  const trip = await create('afternoon_dropoff');
  await startTrip(trip.id, actor);
  await act(trip.id, data.student1.id, 'check_in');
  await act(trip.id, data.student2.id, 'absent');
  await data.parent.update({ dropoffLat: -2 });
  await recordLocation({ trip, schoolId: data.school.id, lat: -1.31, lng: 36.83, source: 'phone' });
  const [driver, details, parent] = await Promise.all([
    request(app).get('/api/driver/active-trip').set('Authorization', `Bearer ${driverToken}`),
    request(app).get(`/api/trips/${trip.id}/details`).set('Authorization', `Bearer ${admin}`),
    request(app).get('/api/location/my-bus').set('Authorization', `Bearer ${parentToken}`),
  ]);
  expect(driver.status).toBe(200);
  expect(details.status).toBe(200);
  expect(parent.status).toBe(200);
  expect(driver.body.activeTrip.currentStop).toMatchObject({ lat: -1.31, lng: 36.83, phase: 'dropoff' });
  expect(details.body.trip.currentStop).toMatchObject({ lat: -1.31, lng: 36.83, phase: 'dropoff' });
  expect(parent.body.activeBuses[0].pendingStops[0]).toMatchObject({ lat: -1.31, lng: 36.83, isMyChild: true });
  expect(parent.body.activeBuses[0].children[0].eta).toMatchObject({ totalMinutes: 1, distanceMeters: 0, phase: 'dropoff' });
});

test('GPS, proximity message and outbox roll back together and the same tracker fix can be retried', async () => {
  await data.vehicle.update({ trackerUniqueId: 'workflow-test-device' });
  const trip = await create();
  const state = await startTrip(trip.id, actor);
  const fix = {
    trip, schoolId: data.school.id, lat: state.currentStop.lat, lng: state.currentStop.lng,
    source: 'traccar', trackerUniqueId: 'workflow-test-device', trackerPositionId: 30001,
  };
  const before = await Message.count();
  const insert = jest.spyOn(NotificationOutbox, 'create').mockRejectedValueOnce(new Error('outbox unavailable'));
  await expect(recordLocation(fix)).rejects.toThrow('outbox unavailable');
  insert.mockRestore();
  expect(await BusLocation.count({ where: { tripId: trip.id } })).toBe(0);
  expect(await Message.count()).toBe(before);
  const saved = await recordLocation(fix);
  expect(saved.created).toBe(true);
  expect((await recordLocation(fix)).created).toBe(false);
  expect(await BusLocation.count({ where: { tripId: trip.id } })).toBe(1);
});

test('stale and out-of-order fixes cannot create alerts or regress the broadcast position', async () => {
  const trip = await create();
  const state = await startTrip(trip.id, actor);
  await trip.update({ startedAt: new Date(Date.now() - 600000) });
  const fix = { trip, schoolId: data.school.id, lat: state.currentStop.lat, lng: state.currentStop.lng, source: 'phone' };
  await recordLocation({ ...fix, recordedAt: new Date(Date.now() - 180000) });
  expect(await NotificationOutbox.count({ where: { event: 'driver-approaching' } })).toBe(0);
  await recordLocation(fix);
  const count = await NotificationOutbox.count();
  const broadcasts = notifyTrip.mock.calls.filter(call => call[1] === 'location-update').length;
  await recordLocation({ ...fix, recordedAt: new Date(Date.now() - 10000) });
  expect(await NotificationOutbox.count()).toBe(count);
  expect(notifyTrip.mock.calls.filter(call => call[1] === 'location-update')).toHaveLength(broadcasts);
  await expect(recordLocation({ ...fix, recordedAt: new Date(Date.now() - 700000) })).rejects.toMatchObject({ status: 400 });
});

test('active routes cannot be edited or deactivated and historical roster filters survive later edits', async () => {
  const trip = await create();
  await startTrip(trip.id, actor);
  for (const response of [
    await request(app).put(`/api/routes/${data.route.id}`).set('Authorization', `Bearer ${admin}`).send({ name: 'Changed' }),
    await request(app).delete(`/api/routes/${data.route.id}`).set('Authorization', `Bearer ${admin}`),
  ]) expect(response.status).toBe(409);
  await act(trip.id, data.student1.id, 'absent');
  await act(trip.id, data.student2.id, 'absent');
  await completeTrip(trip.id, actor);
  await RouteStudent.destroy({ where: { routeId: data.route.id, studentId: data.student2.id } });
  const list = await request(app).get(`/api/trips?studentId=${data.student2.id}`).set('Authorization', `Bearer ${admin}`);
  expect(list.status).toBe(200);
  expect(list.body.trips).toHaveLength(1);
  expect(list.body.trips[0].route.students[0].id).toBe(data.student2.id);
  expect(list.body.trips[0]).not.toHaveProperty('plan');
  const response = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  await require('../controllers/monitoringController').tripHistory({
    query: { schoolId: String(data.school.id), studentId: String(data.student2.id) },
  }, response);
  expect(response.status).not.toHaveBeenCalled();
  expect(response.json.mock.calls[0][0].trips[0].route.students[0].id).toBe(data.student2.id);
  const duplicate = await request(app).post('/api/trips').set('Authorization', `Bearer ${admin}`)
    .send({ routeId: data.route.id, type: 'morning_pickup', scheduledDate: '2026-10-30' });
  expect(duplicate.status).toBe(409);
});

test('super-admin summaries use the authoritative state and frozen roster deletion guards', async () => {
  const trip = await create();
  await startTrip(trip.id, actor);
  const response = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  await require('../controllers/monitoringController').activeTrips({}, response);
  expect(response.json.mock.calls[0][0].activeTrips[0]).toMatchObject({ phase: 'pickup', canEnd: false });
  await RouteStudent.destroy({ where: { routeId: data.route.id, studentId: data.student2.id } });
  const { deleteSchoolResource } = require('../services/superAdminDeletion');
  await expect(deleteSchoolResource(String(data.school.id), 'student', data.student2.id, 'Child Two'))
    .rejects.toMatchObject({ status: 409 });
  await expect(deleteSchoolResource(String(data.school.id), 'parent', data.parent2.id, 'Second Parent'))
    .rejects.toMatchObject({ status: 409 });
});

test('starting and permanently deleting the same route cannot both succeed', async () => {
  const route = await Route.create({
    schoolId: data.school.id, name: 'Concurrent deletion route', driverId: otherDriver.id, vehicleId: otherVehicle.id,
  });
  await RouteStudent.create({ routeId: route.id, studentId: data.student2.id, stopOrder: 1 });
  await RouteWaypoint.create({ routeId: route.id, leg: 'outbound', orderIndex: 0, lat: -1.3, lng: 36.82 });
  const trip = await create('afternoon_dropoff', { routeId: route.id, driverId: otherDriver.id, vehicleId: otherVehicle.id });
  const results = await Promise.allSettled([
    startTrip(trip.id, { id: data.admin.id, schoolId: data.school.id, role: 'school_admin' }),
    require('../services/superAdminDeletion').deleteSchoolResource(data.school.id, 'route', route.id, route.name),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const saved = await Trip.findByPk(trip.id);
  if (saved) {
    expect(saved.status).toBe('in_progress');
    expect(await Route.findByPk(route.id)).not.toBeNull();
  } else {
    expect(await Route.findByPk(route.id)).toBeNull();
  }
});

test('diagnostics enforce role and school boundaries and exclude parent payload/contact details', async () => {
  const trip = await create();
  await startTrip(trip.id, actor);
  const path = `/api/trips/${trip.id}/notifications`;
  const response = await request(app).get(path).set('Authorization', `Bearer ${admin}`);
  expect(response.status).toBe(200);
  expect(response.body.events).toHaveLength(2);
  expect(response.body.events[0]).not.toHaveProperty('payload');
  expect(response.body.events[0]).not.toHaveProperty('receiverId');
  expect((await request(app).get(path).set('Authorization', `Bearer ${parentToken}`)).status).toBe(403);
  expect((await request(app).get(path).set('Authorization', `Bearer ${driverToken}`)).status).toBe(403);
  await expect(require('../services/tripWorkflow').notificationDiagnostics(trip.id, { schoolId: 9999 })).rejects.toMatchObject({ status: 404 });
});

test('an active legacy afternoon trip requires explicit boarding and recognizes old retry logs', async () => {
  const trip = await create('afternoon_dropoff', { status: 'in_progress', startedAt: new Date() });
  const first = await act(trip.id, data.student1.id, 'check_in');
  expect(first.phase).toBe('boarding');
  expect(first.canEnd).toBe(false);
  await TripLog.create({ tripId: trip.id, studentId: data.student2.id, action: 'arrived', phase: null });
  expect((await act(trip.id, data.student2.id, 'arrived')).duplicate).toBe(true);
  await TripLog.create({ tripId: trip.id, studentId: data.student2.id, action: 'check_in', phase: null });
  expect((await act(trip.id, data.student2.id, 'check_in')).duplicate).toBe(true);
});

test('database indexes independently reject overlapping active assignments', async () => {
  await create('morning_pickup', { status: 'in_progress' });
  await expect(create('afternoon_dropoff', { status: 'in_progress' })).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
});

test('notification insertion failure rolls back the trip start', async () => {
  const trip = await create();
  const insert = jest.spyOn(NotificationOutbox, 'create').mockRejectedValueOnce(new Error('outbox unavailable'));
  await expect(startTrip(trip.id, actor)).rejects.toThrow('outbox unavailable');
  insert.mockRestore();
  expect((await trip.reload()).status).toBe('scheduled');
  expect(await Message.count()).toBe(0);
});

test('completion and start retries do not duplicate events', async () => {
  const trip = await create();
  await startTrip(trip.id, actor);
  expect((await startTrip(trip.id, actor)).duplicate).toBe(true);
  await act(trip.id, data.student1.id, 'absent');
  await act(trip.id, data.student2.id, 'absent');
  await completeTrip(trip.id, actor);
  expect((await completeTrip(trip.id, actor)).duplicate).toBe(true);
  expect(await NotificationOutbox.count({ where: { event: 'trip-completed' } })).toBe(2);
});
