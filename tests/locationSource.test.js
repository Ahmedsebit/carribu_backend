const express = require('express');
const http = require('http');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { io: connectClient } = require('socket.io-client');

jest.mock('../models', () => ({
  sequelize: { transaction: jest.fn() },
  VehicleTrackerPosition: { findByPk: jest.fn(), findOne: jest.fn(), upsert: jest.fn() },
  BusLocation: { create: jest.fn(), findOrCreate: jest.fn(), findOne: jest.fn(), findAll: jest.fn() },
  Trip: { findOne: jest.fn(), findByPk: jest.fn(), findAll: jest.fn() },
  Vehicle: { findOne: jest.fn(), findByPk: jest.fn() },
  Route: { findByPk: jest.fn(), findAll: jest.fn() },
  User: { findByPk: jest.fn() },
  Student: { findOne: jest.fn(), findAll: jest.fn() },
  TripLog: { findAll: jest.fn() },
  Message: {},
  School: {},
}));
jest.mock('../services/push', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../services/tripReminders', () => ({
  checkDelayedTrips: jest.fn(), checkMissedTrips: jest.fn(),
}));
jest.mock('../utils/parentSchoolAccess', () => ({
  getActiveParentSchoolIds: jest.fn(),
  hasActiveParentSchool: jest.fn(),
  getActiveParentIdsForSchool: jest.fn(),
}));

const { sequelize, VehicleTrackerPosition, BusLocation, Trip, Vehicle, Route, User, Student, TripLog } = require('../models');
const { hasActiveParentSchool, getActiveParentSchoolIds } = require('../utils/parentSchoolAccess');
const { initSocket } = require('../socket');
const { ingestPosition } = require('../services/trackerIngestion');
const { getTripLocationWhere } = require('../services/locationTracking');
const tripController = require('../controllers/tripController');
const driverController = require('../controllers/driverController');

const app = express();
app.use(express.json());
app.use('/location', require('../routes/location'));
app.use('/vehicles', require('../routes/vehicles'));
const server = http.createServer(app);
const io = initSocket(server);
const secret = 'location-source-tests-only';
const token = (role = 'driver', id = 3, schoolId = 4) => jwt.sign({ id, role, schoolId }, secret);
const payload = { tripId: 2, lat: -1.2, lng: 36.8, speed: 20, heading: 90 };
let originalSecret, vehicle, trip, locations, clients, snapshot;

const invoke = async (handler, req) => {
  const res = { statusCode: 200, status: jest.fn(function status(code) { this.statusCode = code; return this; }), json: jest.fn() };
  await handler(req, res);
  return { status: res.statusCode, body: res.json.mock.calls[0][0] };
};
const post = (body = payload, auth = token()) => request(app).post('/location/update')
  .set('Authorization', `Bearer ${auth}`).send(body);

async function socketClient(role = 'driver', id = 3) {
  const client = connectClient(`http://127.0.0.1:${server.address().port}`, {
    auth: { token: token(role, id) }, transports: ['websocket'], forceNew: true,
  });
  clients.push(client);
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });
  return client;
}

async function until(assertion) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

beforeAll(async () => {
  originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise(resolve => io.close(resolve));
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  locations = [];
  snapshot = null;
  clients = [];
  vehicle = { id: 1, schoolId: 4, status: 'active', trackerUniqueId: 'device-id' };
  trip = {
    id: 2, routeId: 9, driverId: 3, vehicleId: 1, status: 'in_progress',
    startedAt: new Date('2026-10-28T08:00:00Z'), vehicle,
    route: { id: 9, name: 'Test route', schoolId: 4, students: [] }, logs: [],
    toJSON() { return { ...this }; },
  };
  User.findByPk.mockResolvedValue({ id: 3, isActive: true, pickupLat: null, pickupLng: null });
  sequelize.transaction.mockImplementation(async callback => callback({ LOCK: { UPDATE: 'UPDATE' } }));
  VehicleTrackerPosition.findByPk.mockImplementation(async () => snapshot);
  VehicleTrackerPosition.upsert.mockImplementation(async values => { snapshot = { ...values }; });
  VehicleTrackerPosition.findOne.mockImplementation(async ({ where }) => snapshot
    && Object.entries(where).every(([key, value]) => snapshot[key] === value) ? snapshot : null);
  Vehicle.findByPk.mockResolvedValue(vehicle);
  Vehicle.findOne.mockImplementation(async ({ where }) => {
    if (where.trackerUniqueId !== undefined) {
      return where.trackerUniqueId === vehicle.trackerUniqueId && vehicle.status === 'active' ? vehicle : null;
    }
    return where.id === vehicle.id && where.schoolId === vehicle.schoolId ? vehicle : null;
  });
  Trip.findByPk.mockResolvedValue(trip);
  Trip.findOne.mockImplementation(async ({ where, include = [] }) => {
    if (where.id != null && Number(where.id) !== trip.id) return null;
    if (where.driverId != null && where.driverId !== trip.driverId) return null;
    if (where.status && where.status !== trip.status) return null;
    const schoolId = include.find(item => item.as === 'route')?.where?.schoolId;
    if (schoolId != null && schoolId !== trip.route.schoolId) return null;
    return trip;
  });
  Route.findAll.mockResolvedValue([{ id: 9 }]);
  Route.findByPk.mockResolvedValue(null);
  Student.findOne.mockResolvedValue({ id: 5 });
  Student.findAll.mockResolvedValue([]);
  TripLog.findAll.mockResolvedValue([]);
  hasActiveParentSchool.mockResolvedValue(true);
  getActiveParentSchoolIds.mockResolvedValue([4]);
  BusLocation.create.mockImplementation(async values => {
    const location = { id: locations.length + 1, ...values };
    locations.push(location);
    return location;
  });
  BusLocation.findOrCreate.mockImplementation(async ({ where, defaults }) => {
    const existing = locations.find(location => location.trackerPositionId === where.trackerPositionId);
    return existing ? [existing, false] : [await BusLocation.create(defaults), true];
  });
  const matching = where => locations.filter(location =>
    Object.entries(where).every(([key, value]) => location[key] === value));
  BusLocation.findOne.mockImplementation(async ({ where }) => matching(where)
    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))[0] || null);
  BusLocation.findAll.mockImplementation(async ({ where }) => matching(where));
});

afterEach(() => {
  clients.forEach(client => client.disconnect());
  jest.restoreAllMocks();
});

describe('authoritative active-trip location source', () => {
  test('rejects phone REST updates for a linked vehicle, even with a forged source', async () => {
    const response = await post({ ...payload, source: 'traccar', trackerPositionId: 999 });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TRACCAR_LOCATION_REQUIRED');
    expect(BusLocation.create).not.toHaveBeenCalled();
    expect(BusLocation.findOrCreate).not.toHaveBeenCalled();
  });

  test('keeps phone GPS for unlinked vehicles and tags stored data', async () => {
    vehicle.trackerUniqueId = null;
    const response = await post({ ...payload, lat: 0, lng: 0, source: 'traccar' });
    expect(response.status).toBe(201);
    expect(response.body.location).toMatchObject({ lat: 0, lng: 0, source: 'phone', trackerPositionId: null });
  });

  test.each([
    ['completed trip', () => { trip.status = 'completed'; }],
    ['different driver', () => { trip.driverId = 99; }],
    ['different school', () => { trip.route.schoolId = 99; }],
  ])('does not accept phone updates for %s', async (_, change) => {
    vehicle.trackerUniqueId = null;
    change();
    expect((await post()).status).toBe(404);
    expect(BusLocation.create).not.toHaveBeenCalled();
  });

  test.each([{ lat: 91 }, { lng: 181 }, { lat: null }, { lng: '' }])('rejects invalid coordinates %p', async invalid => {
    vehicle.trackerUniqueId = null;
    expect((await post({ ...payload, ...invalid })).status).toBe(400);
    expect(BusLocation.create).not.toHaveBeenCalled();
  });

  test('blocks socket phone updates without broadcasting or persisting them', async () => {
    const driver = await socketClient();
    const received = jest.fn();
    driver.on('location-update', received);
    driver.emit('join-trip', 2);
    const result = await driver.timeout(2000).emitWithAck('driver-location', { ...payload, source: 'traccar' });
    expect(result).toMatchObject({ status: 409, code: 'TRACCAR_LOCATION_REQUIRED' });
    expect(received).not.toHaveBeenCalled();
    expect(locations).toHaveLength(0);
  });

  test('notifies old socket clients of rejected phone GPS even without an acknowledgement callback', async () => {
    const driver = await socketClient();
    const rejected = new Promise(resolve => driver.once('location-error', resolve));
    driver.emit('driver-location', payload);
    await expect(rejected).resolves.toMatchObject({ code: 'TRACCAR_LOCATION_REQUIRED', status: 409 });
    expect(locations).toHaveLength(0);
  });

  test('persists and broadcasts only the server-validated phone source for an unlinked vehicle', async () => {
    vehicle.trackerUniqueId = null;
    const driver = await socketClient();
    const received = jest.fn();
    driver.on('location-update', received);
    driver.emit('join-trip', 2);
    const result = await driver.timeout(2000).emitWithAck('driver-location', { ...payload, source: 'traccar' });
    expect(result).toMatchObject({ accepted: true, source: 'phone' });
    await until(() => expect(received).toHaveBeenCalledWith(expect.objectContaining({ source: 'phone', lat: -1.2, driverId: 3 })));
    expect(locations).toHaveLength(1);
    expect(locations[0].source).toBe('phone');
  });

  test('parents cannot inject locations over the socket', async () => {
    vehicle.trackerUniqueId = null;
    const parent = await socketClient('parent');
    const result = await parent.timeout(2000).emitWithAck('driver-location', payload);
    expect(result.status).toBe(403);
    expect(locations).toHaveLength(0);
  });

  test('persists and broadcasts Traccar updates, including payloads without a position ID', async () => {
    const driver = await socketClient();
    const received = jest.fn();
    driver.on('location-update', received);
    driver.emit('join-trip', 2);
    await until(() => expect(io.sockets.adapter.rooms.get('trip:2')?.size).toBe(1));
    const position = { latitude: -1.3, longitude: 36.9, fixTime: '2026-10-28T08:05:00Z', speed: 10, valid: true };
    const result = await ingestPosition({ device: { uniqueId: 'device-id' }, position });
    expect(result.status).toBe(201);
    expect(locations[0]).toMatchObject({ source: 'traccar', trackerPositionId: null });
    await until(() => expect(received).toHaveBeenCalledWith(expect.objectContaining({ source: 'traccar', lat: -1.3 })));
  });

  test('live map and history use device fixes, not a newer cached phone position', async () => {
    locations.push(
      { tripId: 2, lat: -1.3, lng: 36.9, source: 'traccar', speed: 0, heading: 0, recordedAt: new Date('2026-10-28T08:05:00Z') },
      { tripId: 2, lat: -2, lng: 37, source: 'phone', recordedAt: new Date('2026-10-28T08:10:00Z') },
    );
    const response = await request(app).get('/location/bus/2').set('Authorization', `Bearer ${token()}`);
    expect(response.status).toBe(200);
    expect(response.body.location).toMatchObject({ source: 'traccar', lat: -1.3, speed: 0, heading: 0 });
    const history = await request(app).get('/location/history/2').set('Authorization', `Bearer ${token()}`);
    expect(history.body.locations).toHaveLength(1);
    expect(history.body.locations[0].source).toBe('traccar');
  });

  test('shows an ingested Traccar fix on the admin vehicle map only while the trip is active', async () => {
    const position = {
      id: 700, latitude: -1.3, longitude: 36.9,
      fixTime: '2026-10-28T08:05:00Z', speed: 0, course: 0, valid: true,
    };
    expect((await ingestPosition({ device: { uniqueId: 'device-id' }, position })).status).toBe(201);
    const readLocation = () => request(app).get('/vehicles/1/location')
      .set('Authorization', `Bearer ${token('school_admin')}`);
    const response = await readLocation();
    expect(response.status).toBe(200);
    expect(response.body.location).toMatchObject({
      source: 'traccar', lat: -1.3, lng: 36.9, speed: 0, heading: 0,
    });
    trip.status = 'completed';
    const ended = await readLocation();
    expect(ended.status).toBe(200);
    expect(ended.body).toEqual({ trip: null, location: null, locationSource: 'traccar' });
    expect(locations).toHaveLength(1);
  });

  test('shows an older device snapshot without adding it to trip history or running arrival logic', async () => {
    const position = {
      id: 700, latitude: -1.3, longitude: 36.9,
      fixTime: '2026-10-28T07:00:00Z', speed: 0, course: 0, valid: true,
    };
    const result = await ingestPosition({ device: { uniqueId: 'device-id' }, position });
    expect(result.body.ignored).toBe('position_before_trip');
    expect(locations).toHaveLength(0);
    expect(Route.findByPk).not.toHaveBeenCalled();
    expect(Vehicle.findOne).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 1, trackerUniqueId: 'device-id', status: 'active' },
      lock: 'UPDATE', transaction: expect.anything(),
    }));
    const response = await request(app).get('/vehicles/1/location')
      .set('Authorization', `Bearer ${token('school_admin')}`);
    expect(response.status).toBe(200);
    expect(response.body.location).toMatchObject({
      lat: -1.3, lng: 36.9, source: 'traccar', isLastKnown: true, predatesTrip: true,
      recordedAt: '2026-10-28T07:00:00.000Z',
    });
    const history = await request(app).get('/location/history/2')
      .set('Authorization', `Bearer ${token('school_admin')}`);
    expect(history.body.locations).toEqual([]);

    await ingestPosition({ device: { uniqueId: 'device-id' }, position: {
      ...position, id: 701, latitude: -1.4, fixTime: '2026-10-28T08:05:00Z',
    } });
    const fresh = await request(app).get('/vehicles/1/location')
      .set('Authorization', `Bearer ${token('school_admin')}`);
    expect(fresh.body.location).toMatchObject({ lat: -1.4, isLastKnown: false, predatesTrip: false });
    expect(locations).toHaveLength(1);
  });

  test('a delayed older fix cannot overwrite a newer snapshot', async () => {
    const position = { latitude: -1.3, longitude: 36.9, valid: true, fixTime: '2026-10-28T07:00:00Z' };
    await ingestPosition({ device: { uniqueId: 'device-id' }, position });
    await ingestPosition({ device: { uniqueId: 'device-id' }, position: {
      ...position, latitude: -2, fixTime: '2026-10-28T06:00:00Z',
    } });
    expect(snapshot.lat).toBe(-1.3);
    expect(snapshot.recordedAt.toISOString()).toBe('2026-10-28T07:00:00.000Z');
    expect(VehicleTrackerPosition.upsert).toHaveBeenCalledTimes(1);
  });

  test('rechecks the tracker mapping before saving its snapshot', async () => {
    Vehicle.findOne.mockResolvedValueOnce(vehicle).mockResolvedValueOnce(null);
    const result = await ingestPosition({ device: { uniqueId: 'device-id' }, position: {
      latitude: -1.3, longitude: 36.9, valid: true, fixTime: '2026-10-28T07:00:00Z',
    } });
    expect(result.body.ignored).toBe('tracker_assignment_changed');
    expect(VehicleTrackerPosition.upsert).not.toHaveBeenCalled();
    expect(locations).toHaveLength(0);
  });

  test('hides the old device snapshot after reassignment and accepts the new device original timestamp', async () => {
    const position = { latitude: -1.3, longitude: 36.9, valid: true, fixTime: '2026-10-28T07:00:00Z' };
    await ingestPosition({ device: { uniqueId: 'device-id' }, position });
    vehicle.trackerUniqueId = 'replacement-device';
    const read = () => request(app).get('/vehicles/1/location')
      .set('Authorization', `Bearer ${token('school_admin')}`);
    expect((await read()).body.location).toBeNull();
    await ingestPosition({ device: { uniqueId: 'replacement-device' }, position: {
      ...position, latitude: -2, fixTime: '2026-10-28T06:00:00Z',
    } });
    expect((await read()).body.location).toMatchObject({
      lat: -2, isLastKnown: true, recordedAt: '2026-10-28T06:00:00.000Z',
    });
  });

  test('does not save or expose snapshots without an active trip', async () => {
    trip.status = 'completed';
    const result = await ingestPosition({ device: { uniqueId: 'device-id' }, position: {
      latitude: -1.3, longitude: 36.9, valid: true, fixTime: '2026-10-28T07:00:00Z',
    } });
    expect(result.body.ignored).toBe('no_active_trip');
    expect(sequelize.transaction).not.toHaveBeenCalled();
    const response = await request(app).get('/vehicles/1/location')
      .set('Authorization', `Bearer ${token('school_admin')}`);
    expect(response.body.location).toBeNull();
    expect(VehicleTrackerPosition.findOne).not.toHaveBeenCalled();
  });

  test('does not fall back to phone GPS while waiting for the first device fix', async () => {
    locations.push({ tripId: 2, source: 'phone', lat: -2, lng: 37 });
    const response = await request(app).get('/location/bus/2').set('Authorization', `Bearer ${token()}`);
    expect(response.status).toBe(404);
    expect((await request(app).get('/location/history/2').set('Authorization', `Bearer ${token()}`)).body.locations).toEqual([]);
  });

  test('completed trip history retains all originally recorded sources', async () => {
    trip.status = 'completed';
    expect(await getTripLocationWhere(trip)).toEqual({ tripId: 2 });
  });

  test('reloads a missing vehicle association rather than silently selecting phone GPS', async () => {
    delete trip.vehicle;
    expect(await getTripLocationWhere(trip)).toEqual({ tripId: 2, source: 'traccar' });
    Vehicle.findByPk.mockResolvedValueOnce(null);
    await expect(getTripLocationWhere(trip)).rejects.toMatchObject({ status: 404 });
  });

  test('parent access checks still apply to device-based location reads', async () => {
    hasActiveParentSchool.mockResolvedValueOnce(false);
    const response = await request(app).get('/location/bus/2').set('Authorization', `Bearer ${token('parent')}`);
    expect(response.status).toBe(404);
    expect(BusLocation.findOne).not.toHaveBeenCalled();
  });

  test('school users cannot read locations for another school', async () => {
    const response = await request(app).get('/location/bus/2').set('Authorization', `Bearer ${token('school_admin', 3, 99)}`);
    expect(response.status).toBe(404);
    expect(BusLocation.findOne).not.toHaveBeenCalled();
  });

  test('the parent active-bus view and school-admin trip details select Traccar positions', async () => {
    locations.push({ tripId: 2, source: 'phone', lat: -2, lng: 37 });
    Student.findAll.mockResolvedValueOnce([{
      id: 5, firstName: 'Child', routes: [{
        id: 9, name: 'Route', students: [], trips: [trip],
      }],
    }]);
    const parent = await request(app).get('/location/my-bus').set('Authorization', `Bearer ${token('parent')}`);
    expect(parent.status).toBe(200);
    expect(parent.body.activeBuses[0].location).toBeNull();
    const details = await invoke(tripController.getDetails, { params: { id: 2 }, user: { schoolId: 4 } });
    expect(details.status).toBe(200);
    expect(details.body.trip.location).toBeNull();
    expect(BusLocation.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { tripId: 2, source: 'traccar' } }));
  });

  test('the driver active-trip response announces the device location source', async () => {
    const response = await invoke(driverController.getActiveTrip, { user: { id: 3 } });
    expect(response.status).toBe(200);
    expect(response.body.activeTrip.locationSource).toBe('traccar');
    vehicle.trackerUniqueId = null;
    const unlinked = await invoke(driverController.getActiveTrip, { user: { id: 3 } });
    expect(unlinked.body.activeTrip.locationSource).toBe('phone');
  });
});
