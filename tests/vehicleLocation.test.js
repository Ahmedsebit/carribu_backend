const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../models', () => ({
  Vehicle: { findOne: jest.fn() },
  Trip: { findOne: jest.fn() },
  BusLocation: { findOne: jest.fn() },
  VehicleTrackerPosition: { findOne: jest.fn() },
  User: { findByPk: jest.fn() },
  School: {}, Route: {}, Student: {}, TripLog: {}, Message: {},
}));
jest.mock('../socket', () => ({ notifyTrip: jest.fn(), notifyUser: jest.fn() }));
jest.mock('../utils/parentSchoolAccess', () => ({ getActiveParentIdsForSchool: jest.fn() }));

const { Vehicle, Trip, BusLocation, User, VehicleTrackerPosition } = require('../models');
const app = express();
app.use('/api/vehicles', require('../routes/vehicles'));
const secret = 'vehicle-location-test-secret';
let originalSecret, vehicle, trip, locations;
const getLocation = (role = 'school_admin', schoolId = 1, id = '12') =>
  request(app).get(`/api/vehicles/${id}/location`)
    .set('Authorization', `Bearer ${jwt.sign({ id: 8, role, schoolId }, secret)}`);

beforeAll(() => {
  originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = secret;
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

beforeEach(() => {
  jest.resetAllMocks();
  vehicle = { id: 12, schoolId: 1, trackerUniqueId: 'test-device' };
  trip = {
    id: 5, vehicleId: 12, status: 'in_progress',
    startedAt: new Date('2026-10-29T08:00:00Z'),
    route: { id: 3, name: 'Test route', schoolId: 1 },
  };
  locations = [];
  User.findByPk.mockResolvedValue({ id: 8, isActive: true });
  VehicleTrackerPosition.findOne.mockResolvedValue(null);
  Vehicle.findOne.mockImplementation(async ({ where }) =>
    where.id === vehicle.id && where.schoolId === vehicle.schoolId ? vehicle : null);
  Trip.findOne.mockImplementation(async ({ where, include }) =>
    trip && where.vehicleId === trip.vehicleId && where.status === trip.status
      && include[0].where.schoolId === trip.route.schoolId ? trip : null);
  BusLocation.findOne.mockImplementation(async ({ where }) => locations
    .filter(location => Object.entries(where).every(([key, value]) => location[key] === value))
    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))[0] || null);
});

test('requires authentication', async () => {
  const response = await request(app).get('/api/vehicles/12/location');
  expect(response.status).toBe(401);
  expect(Vehicle.findOne).not.toHaveBeenCalled();
});

test.each(['parent', 'driver', 'super_admin'])('rejects %s access', async role => {
  expect((await getLocation(role)).status).toBe(403);
  expect(Vehicle.findOne).not.toHaveBeenCalled();
});

test.each(['school_admin', 'coordinator'])('allows %s to read only the linked device source', async role => {
  locations.push(
    { tripId: 5, vehicleId: 12, source: 'traccar', lat: '-1.3', lng: '36.8', speed: '0', heading: '0', recordedAt: '2026-10-29T08:00:00Z' },
    { tripId: 5, vehicleId: 12, source: 'phone', lat: '-2', lng: '37', recordedAt: '2026-10-29T08:10:00Z' },
  );
  const response = await getLocation(role);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({
    trip: { id: 5, status: 'in_progress', route: { name: 'Test route' } },
    locationSource: 'traccar',
    location: { lat: -1.3, lng: 36.8, speed: 0, heading: 0, source: 'traccar', recordedAt: '2026-10-29T08:00:00Z' },
  });
  expect(BusLocation.findOne).toHaveBeenCalledWith(expect.objectContaining({
    where: { tripId: 5, vehicleId: 12, source: 'traccar' },
    order: [['recorded_at', 'DESC']],
  }));
  expect(Trip.findOne).toHaveBeenCalledWith(expect.objectContaining({
    where: { vehicleId: 12, status: 'in_progress' },
    include: [expect.objectContaining({ where: { schoolId: 1 }, required: true })],
  }));
});

test('does not expose a vehicle belonging to another school', async () => {
  const response = await getLocation('school_admin', 2);
  expect(response.status).toBe(404);
  expect(Trip.findOne).not.toHaveBeenCalled();
  expect(BusLocation.findOne).not.toHaveBeenCalled();
  expect(VehicleTrackerPosition.findOne).not.toHaveBeenCalled();
});

test.each([null, 'completed', 'scheduled', 'cancelled'])('returns no map without an active trip (%s)', async status => {
  if (status === null) trip = null;
  else trip.status = status;
  const response = await getLocation();
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ trip: null, location: null, locationSource: 'traccar' });
  expect(BusLocation.findOne).not.toHaveBeenCalled();
});

test('does not use a trip whose route belongs to a different school', async () => {
  trip.route.schoolId = 2;
  expect((await getLocation()).body.trip).toBeNull();
  expect(BusLocation.findOne).not.toHaveBeenCalled();
});

test('waits for the first device fix without falling back to phone, other trips or other vehicles', async () => {
  locations.push(
    { tripId: 5, vehicleId: 12, source: 'phone', lat: -1, lng: 36 },
    { tripId: 4, vehicleId: 12, source: 'traccar', lat: -1, lng: 36 },
    { tripId: 5, vehicleId: 13, source: 'traccar', lat: -1, lng: 36 },
  );
  const response = await getLocation();
  expect(response.status).toBe(200);
  expect(response.body.trip.id).toBe(5);
  expect(response.body.location).toBeNull();
  expect(response.body.locationSource).toBe('traccar');
});

test('keeps phone GPS for vehicles without a linked tracker', async () => {
  vehicle.trackerUniqueId = null;
  locations.push(
    { tripId: 5, vehicleId: 12, source: 'phone', lat: '0', lng: '0', speed: null, heading: null, recordedAt: '2026-10-29T08:10:00Z' },
    { tripId: 5, vehicleId: 12, source: 'traccar', lat: '-1', lng: '36', recordedAt: '2026-10-29T08:20:00Z' },
  );
  const response = await getLocation();
  expect(response.body).toMatchObject({
    locationSource: 'phone', location: { lat: 0, lng: 0, speed: null, heading: null, source: 'phone' },
  });
});

test('returns the newest authoritative fix', async () => {
  locations.push(
    { tripId: 5, vehicleId: 12, source: 'traccar', lat: -1, lng: 36, recordedAt: '2026-10-29T08:00:00Z' },
    { tripId: 5, vehicleId: 12, source: 'traccar', lat: -2, lng: 37, recordedAt: '2026-10-29T08:10:00Z' },
  );
  expect((await getLocation()).body.location.lat).toBe(-2);
  expect(VehicleTrackerPosition.findOne).not.toHaveBeenCalled();
});

test('shows a matching last-known snapshot with its original pre-trip timestamp', async () => {
  VehicleTrackerPosition.findOne.mockResolvedValue({
    lat: '-1.3', lng: '36.8', speed: '0', heading: '0',
    recordedAt: new Date('2026-10-29T07:00:00Z'),
  });
  const response = await getLocation();
  expect(response.status).toBe(200);
  expect(response.body.location).toEqual({
    lat: -1.3, lng: 36.8, speed: 0, heading: 0, recordedAt: '2026-10-29T07:00:00.000Z',
    source: 'traccar', isLastKnown: true, predatesTrip: true,
  });
  expect(VehicleTrackerPosition.findOne).toHaveBeenCalledWith({
    where: { vehicleId: 12, trackerUniqueId: 'test-device' },
  });
});

test('does not read snapshots outside active trips or after unlinking', async () => {
  trip.status = 'completed';
  expect((await getLocation()).body.location).toBeNull();
  expect(VehicleTrackerPosition.findOne).not.toHaveBeenCalled();
  trip.status = 'in_progress';
  vehicle.trackerUniqueId = null;
  expect((await getLocation()).body.location).toBeNull();
  expect(VehicleTrackerPosition.findOne).not.toHaveBeenCalled();
});

test('surfaces snapshot retrieval failures instead of treating them as no GPS fix', async () => {
  VehicleTrackerPosition.findOne.mockRejectedValue(new Error('Snapshot retrieval unavailable.'));
  const response = await getLocation();
  expect(response.status).toBe(500);
  expect(response.body.error).toBe('Snapshot retrieval unavailable.');
});

test.each(['0', '-1', 'invalid', '1.5', '9007199254740992'])('rejects invalid vehicle ID %s', async id => {
  expect((await getLocation('school_admin', 1, id)).status).toBe(400);
  expect(Vehicle.findOne).not.toHaveBeenCalled();
});

test('surfaces location retrieval failures rather than returning an empty successful result', async () => {
  BusLocation.findOne.mockRejectedValueOnce(new Error('Location database unavailable.'));
  const response = await getLocation();
  expect(response.status).toBe(500);
  expect(response.body.error).toBe('Location database unavailable.');
});
