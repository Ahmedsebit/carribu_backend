jest.mock('../models', () => ({
  sequelize: { transaction: jest.fn(), query: jest.fn() },
  Trip: { findByPk: jest.fn(), findAll: jest.fn() },
  TripLog: { findAll: jest.fn() },
  Route: { findOne: jest.fn(), findByPk: jest.fn() },
  User: { findOne: jest.fn() },
  Vehicle: { findOne: jest.fn() },
}));
jest.mock('../socket', () => ({ notifyTrip: jest.fn() }));
jest.mock('../services/notificationOutbox', () => ({ enqueueNotification: jest.fn() }));
jest.mock('../services/tripReminders', () => ({
  isStartWindowEarly: jest.fn(() => false),
  isStartWindowLapsed: jest.fn(() => false),
}));

const { sequelize, Trip, TripLog, Route, User, Vehicle } = require('../models');
const { enqueueNotification } = require('../services/notificationOutbox');
const { startTrip, completeTrip, logStudentAction } = require('../services/tripWorkflow');
const { buildTripPlan } = require('../services/tripPlan');

const actor = { id: 3, schoolId: 1, role: 'driver' };
let trip, route;

beforeEach(() => {
  jest.clearAllMocks();
  const transaction = { LOCK: { UPDATE: 'UPDATE' }, afterCommit: jest.fn() };
  sequelize.transaction.mockImplementation(operation => operation(transaction));
  trip = {
    id: 1, routeId: 1, driverId: 3, vehicleId: 1, type: 'morning_pickup', status: 'scheduled',
    update: jest.fn(async values => Object.assign(trip, values)),
  };
  route = {
    id: 1, schoolId: 1, isActive: true, name: 'Route',
    routeWaypoints: [{ leg: 'outbound', orderIndex: 0, lat: 4, lng: 32 }],
    students: [1, 2].map(id => ({
      id, schoolId: 1, isActive: true, firstName: 'Child', lastName: String(id),
      RouteStudent: { stopOrder: id },
      parent: { id: id + 10, pickupLat: id, pickupLng: 30 },
    })),
  };
  Trip.findByPk.mockImplementation(async () => trip);
  Trip.findAll.mockResolvedValue([]);
  TripLog.findAll.mockResolvedValue([]);
  Route.findOne.mockImplementation(async () => route);
  Route.findByPk.mockImplementation(async () => route);
  User.findOne.mockResolvedValue({ firstName: 'Test', lastName: 'Driver' });
  Vehicle.findOne.mockResolvedValue({ capacity: 1 });
});

test.each([
  { pickupLat: null }, { pickupLng: undefined }, { pickupLat: '' },
  { pickupLat: '   ' }, { pickupLat: false }, { pickupLat: 'bad' },
  { pickupLat: 91 }, { pickupLng: -181 }, { pickupLat: Infinity },
])('starts and excludes students with invalid pickup coordinates %p', async invalid => {
  Object.assign(route.students[0].parent, invalid);
  const started = await startTrip(trip.id, actor);
  expect(started.trip.status).toBe('in_progress');
  expect(started.pickupList.map(stop => stop.studentId)).toEqual([2]);
  expect(started.currentStop.stopNumber).toBe(1);
  expect(started.stats.total).toBe(1);
  expect(trip.plan.stops.map(stop => stop.studentId)).toEqual([2]);
  expect(enqueueNotification).toHaveBeenCalledTimes(1);
  expect(enqueueNotification.mock.calls[0][0].student.studentId).toBe(2);
  await expect(logStudentAction(trip.id, actor, { studentId: 1, action: 'check_in' }))
    .rejects.toMatchObject({ status: 404 });
  TripLog.findAll.mockResolvedValue([{ id: 1, studentId: 2, action: 'absent', timestamp: new Date() }]);
  expect((await completeTrip(trip.id, actor)).trip.status).toBe('completed');
});

test.each(['morning_pickup', 'afternoon_dropoff'])('all invalid students can be skipped and the %s trip completed', async type => {
  trip.type = type;
  route.students.forEach(student => { student.parent.pickupLat = null; });
  const started = await startTrip(trip.id, actor);
  expect(started.trip.status).toBe('in_progress');
  expect(started.pickupList).toEqual([]);
  expect(started.currentStop).toBeNull();
  expect(started.canEnd).toBe(true);
  expect(enqueueNotification).not.toHaveBeenCalled();
  expect((await completeTrip(trip.id, actor)).trip.status).toBe('completed');
});

test('afternoon uses valid drop-off coordinates or falls back to valid pickup coordinates', async () => {
  trip.type = 'afternoon_dropoff';
  Object.assign(route.students[0].parent, { pickupLat: null, dropoffLat: 0, dropoffLng: 0 });
  Object.assign(route.students[1].parent, { pickupLat: 91, dropoffLat: 91, dropoffLng: 30 });
  const started = await startTrip(trip.id, actor);
  expect(started.pickupList.map(stop => stop.studentId)).toEqual([1]);
  expect(trip.plan.stops[0].dropoff).toMatchObject({ lat: 0, lng: 0 });
});

test('filters invalid coordinates in an already saved plan before starting', async () => {
  route.students[0].parent.pickupLat = null;
  trip.plan = buildTripPlan(trip, route, route.routeWaypoints);
  const started = await startTrip(trip.id, actor);
  expect(started.pickupList.map(stop => stop.studentId)).toEqual([2]);
});

test('valid zero pickup coordinates are retained', async () => {
  Object.assign(route.students[0].parent, { pickupLat: 0, pickupLng: 0 });
  route.students[1].parent = null;
  const started = await startTrip(trip.id, actor);
  expect(started.currentStop).toMatchObject({ studentId: 1, lat: 0, lng: 0 });
});

test('still rejects a missing school destination and a genuinely empty route', async () => {
  route.routeWaypoints = [];
  await expect(startTrip(trip.id, actor)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/school destination/) });
  route.students = [];
  await expect(startTrip(trip.id, actor)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/at least one student/) });
});
