const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');

jest.mock('../models', () => ({
  sequelize: { transaction: jest.fn(), query: jest.fn() },
  Student: { findOne: jest.fn(), findAll: jest.fn() },
  User: { findOne: jest.fn(), findByPk: jest.fn() },
  ParentSchool: { findOne: jest.fn(), findAll: jest.fn() },
  Vehicle: { findOne: jest.fn(), count: jest.fn() },
  Route: { findOne: jest.fn(), findByPk: jest.fn() },
  RouteStudent: { findOne: jest.fn(), findAll: jest.fn(), findOrCreate: jest.fn(), destroy: jest.fn(), bulkCreate: jest.fn() },
  RouteWaypoint: { findOne: jest.fn() },
  Trip: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), count: jest.fn(), create: jest.fn(), bulkCreate: jest.fn(), update: jest.fn() },
  TripLog: { findAll: jest.fn(), create: jest.fn() },
  AbsenceRequest: { findOne: jest.fn(), findAndCountAll: jest.fn(), create: jest.fn() },
  Message: { create: jest.fn() },
}));
jest.mock('../socket', () => ({ notifyTrip: jest.fn(), notifyUser: jest.fn() }));
jest.mock('../services/notificationOutbox', () => ({ enqueueNotification: jest.fn() }));
jest.mock('../services/locationTracking', () => ({}));

const models = require('../models');
const students = require('../controllers/studentController');
const vehicles = require('../controllers/vehicleController');
const trips = require('../controllers/tripController');
const absences = require('../controllers/absenceController');
const messages = require('../controllers/messageController');
const workflow = require('../services/tripWorkflow');
const { buildTripPlan } = require('../services/tripPlan');
const { schoolDate, isStartWindowEarly, isStartWindowLapsed, tripStartMs } = require('../services/tripReminders');
const actor = { id: 3, schoolId: 1, role: 'school_admin', isActive: true };
const parent = { id: 11, schoolId: 1, role: 'parent', isActive: true };
const offset = Number(process.env.SCHOOL_UTC_OFFSET_HOURS || 3) * 3600000;
const atSchool = dateTime => Date.parse(`${dateTime}Z`) - offset;
const row = data => {
  const value = { ...data };
  value.update = jest.fn(async updates => Object.assign(value, updates));
  value.toJSON = () => Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function'));
  return value;
};
const response = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn(code => { res.statusCode = code; return res; });
  res.json = jest.fn(() => res);
  return res;
};
let child, route, vehicle, trip, absence, transaction;
const req = (body = {}, user = actor, id = child.id) => ({ body, user, params: { id }, query: {} });

beforeEach(() => {
  jest.resetAllMocks();
  transaction = { LOCK: { UPDATE: 'UPDATE' }, afterCommit: jest.fn() };
  models.sequelize.transaction.mockImplementation(operation => operation(transaction));
  child = row({ id: 20, schoolId: 1, parentId: 11, isActive: true, firstName: 'Test', lastName: 'Child',
    parent: { id: 11, pickupLat: 0, pickupLng: 0 }, RouteStudent: { stopOrder: 1 } });
  route = row({ id: 9, schoolId: 1, driverId: 12, vehicleId: 8, isActive: true, type: 'both', name: 'Test route',
    students: [child], routeWaypoints: [{ leg: 'outbound', orderIndex: 1, lat: 1, lng: 1, label: 'School' }] });
  vehicle = row({ id: 8, schoolId: 1, status: 'active', capacity: 30, trackerUniqueId: 'test-device' });
  trip = row({ id: 30, routeId: 9, driverId: 12, vehicleId: 8, scheduledDate: '2099-11-20',
    scheduledTime: '08:00:00', status: 'in_progress', type: 'morning_pickup', route,
    plan: buildTripPlan({ type: 'morning_pickup' }, route, route.routeWaypoints) });
  absence = row({ id: 60, schoolId: 1, studentId: 20, parentId: 11, date: trip.scheduledDate,
    status: 'pending', confirmedTripIds: [], student: child, parent });
  models.Student.findOne.mockImplementation(async ({ where }) => Object.entries(where).every(([key, value]) =>
    child[key] === (['id', 'schoolId', 'parentId'].includes(key) ? Number(value) : value)) ? child : null);
  models.Student.findAll.mockResolvedValue([child]);
  models.ParentSchool.findAll.mockResolvedValue([{ schoolId: 1 }]);
  models.RouteStudent.findAll.mockResolvedValue([{ routeId: 9, studentId: 20 }]);
  models.Route.findOne.mockImplementation(async ({ where }) =>
    Number(where.schoolId) === route.schoolId && Number(where.id) === route.id ? route : null);
  models.Route.findByPk.mockResolvedValue(route);
  models.Vehicle.findOne.mockResolvedValue(vehicle);
  models.User.findOne.mockResolvedValue({ id: 12, schoolId: 1, isActive: true, role: 'driver' });
  models.User.findByPk.mockResolvedValue(actor);
  models.Trip.findByPk.mockResolvedValue(trip);
  models.Trip.findOne.mockResolvedValue(trip);
  models.Trip.findAll.mockResolvedValue([]);
  models.Trip.count.mockResolvedValue(0);
  models.TripLog.findAll.mockResolvedValue([]);
  models.TripLog.create.mockImplementation(async data => row({ ...data, id: 1 }));
  models.Trip.create.mockImplementation(async data => row({ ...data, id: 31 }));
  models.Trip.bulkCreate.mockImplementation(async values => values.map(data => row(data)));
  models.AbsenceRequest.findOne.mockImplementation(async ({ where }) =>
    Number(where.schoolId) === absence.schoolId && (where.id == null || Number(where.id) === absence.id) ? absence : null);
  models.AbsenceRequest.findAndCountAll.mockResolvedValue({ rows: [absence], count: 1 });
  models.AbsenceRequest.create.mockImplementation(async data => row({ ...data, id: 61, status: 'pending' }));
});

describe('student lifecycle and frozen rosters', () => {
  test('deactivation retains assignments and refreshes only future plans under the school lock', async () => {
    models.Trip.findAll.mockImplementation(async ({ where }) => where.status === 'in_progress' ? [] : [
      { id: 31, routeId: route.id, type: 'morning_pickup', scheduledDate: '2099-11-20' },
    ]);
    const res = response();
    await students.delete(req(), res);
    expect(res.statusCode).toBe(200);
    expect(child.isActive).toBe(false);
    expect(models.RouteStudent.destroy).not.toHaveBeenCalled();
    expect(models.Trip.update).toHaveBeenCalledWith({ plan: expect.objectContaining({ stops: [] }) }, {
      where: { id: { [Op.in]: [31] }, status: { [Op.in]: ['scheduled', 'delayed'] }, startedAt: null }, transaction,
    });
    expect(models.sequelize.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), expect.objectContaining({ transaction }));
  });
  test.each([true, false])('blocks deactivation through either endpoint while rostered on an active trip (snapshot=%s)', async snapshot => {
    if (!snapshot) trip.plan = null;
    models.Trip.findAll.mockResolvedValue([trip]);
    models.RouteStudent.findOne.mockResolvedValue({ studentId: child.id });
    const res = response();
    await (snapshot ? students.update(req({ isActive: false }), res) : students.delete(req(), res));
    expect(res.statusCode).toBe(409);
    expect(child.update).not.toHaveBeenCalled();
  });
  test('allows deactivation when the frozen active roster excludes this student', async () => {
    trip.plan.stops = [];
    models.Trip.findAll.mockImplementation(async ({ where }) => where.status === 'in_progress' ? [trip] : []);
    const res = response();
    await students.delete(req(), res);
    expect(res.statusCode).toBe(200);
  });
  test('reactivation restores future eligibility without changing active snapshots', async () => {
    child.isActive = false;
    const snapshot = JSON.stringify(trip.plan);
    const res = response();
    await students.update(req({ isActive: true }), res);
    expect(res.statusCode).toBe(200);
    expect(child.isActive).toBe(true);
    expect(JSON.stringify(trip.plan)).toBe(snapshot);
    expect(models.RouteStudent.destroy).not.toHaveBeenCalled();
  });
  test('rejects string booleans rather than bypassing the deactivation guard', async () => {
    const res = response();
    await students.update(req({ isActive: 'false' }), res);
    expect(res.statusCode).toBe(400);
    expect(child.update).not.toHaveBeenCalled();
  });
  test('refreshing future plans preserves already lapsed schedules even before the missed-trip job runs', async () => {
    models.Trip.findAll.mockResolvedValue([
      { id: 31, routeId: route.id, type: 'morning_pickup', scheduledDate: '2099-11-20' },
      { id: 32, routeId: route.id, type: 'morning_pickup', scheduledDate: '2000-01-01' },
    ]);
    expect(await workflow.refreshFuturePlans(1, { routeId: route.id }, transaction)).toEqual([31]);
    expect(models.Trip.update.mock.calls[0][1].where.id[Op.in]).toEqual([31]);
    expect(models.Trip.update.mock.calls[0][0].plan.stops.map(stop => stop.studentId)).toEqual([child.id]);
  });
  test('route assignment is transactional and cannot replace an active route roster', async () => {
    models.Trip.count.mockResolvedValue(1);
    const res = response();
    await students.assignRoute(req({ routeId: route.id }), res);
    expect(res.statusCode).toBe(409);
    expect(models.RouteStudent.findOrCreate).not.toHaveBeenCalled();
  });
});

describe('vehicle active-trip protection', () => {
  test.each([{ capacity: 25 }, { status: 'maintenance' }, { status: 'retired' }])('rejects disruptive change %p while active', async body => {
    models.Trip.count.mockResolvedValue(1);
    const res = response();
    await vehicles.update(req(body, actor, vehicle.id), res);
    expect(res.statusCode).toBe(409);
    expect(vehicle.update).not.toHaveBeenCalled();
    expect(vehicle.trackerUniqueId).toBe('test-device');
  });
  test('retirement uses the same active-trip guard', async () => {
    models.Trip.count.mockResolvedValue(1);
    const res = response();
    await vehicles.delete(req({}, actor, vehicle.id), res);
    expect(res.statusCode).toBe(409);
    expect(vehicle.status).toBe('active');
  });
  test('allows non-disruptive updates and unchanged capacity/status during an active trip', async () => {
    models.Trip.count.mockResolvedValue(1);
    const res = response();
    await vehicles.update(req({ color: 'Blue', capacity: '30', status: 'active' }, actor, vehicle.id), res);
    expect(res.statusCode).toBe(200);
    expect(vehicle.update).toHaveBeenCalledWith({ color: 'Blue', capacity: 30, status: 'active' }, { transaction });
  });
});

describe('trip scheduling and legacy date windows', () => {
  const payload = { routeId: 9, type: 'morning_pickup', scheduledDate: '2099-11-20', scheduledTime: '08:00' };
  test('requires a time for every new trip before writing', async () => {
    const res = response();
    await trips.create(req({ ...payload, scheduledTime: null }), res);
    expect(res.statusCode).toBe(400);
    expect(models.Trip.create).not.toHaveBeenCalled();
  });
  test.each(['inactive route', 'wrong direction', 'inactive driver', 'inactive vehicle', 'capacity', 'missing coordinates', 'empty roster'])('rejects scheduling with %s before writes', async problem => {
    if (problem === 'inactive route') route.isActive = false;
    if (problem === 'wrong direction') route.type = 'afternoon';
    if (problem === 'inactive driver') models.User.findOne.mockResolvedValue(null);
    if (problem === 'inactive vehicle') models.Vehicle.findOne.mockResolvedValue(null);
    if (problem === 'capacity') vehicle.capacity = 0;
    if (problem === 'missing coordinates') child.parent.pickupLat = null;
    if (problem === 'empty roster') child.isActive = false;
    const res = response();
    await trips.create(req(payload), res);
    expect([409, 422]).toContain(res.statusCode);
    expect(models.Trip.create).not.toHaveBeenCalled();
  });
  test('valid schedules load readiness inside the creation transaction', async () => {
    const res = response();
    await trips.create(req(payload), res);
    expect(res.statusCode).toBe(201);
    expect(models.Route.findOne).toHaveBeenCalledWith(expect.objectContaining({ transaction }));
    expect(models.Trip.create).toHaveBeenCalledWith(expect.objectContaining({
      scheduledTime: '08:00:00', driverId: 12, plan: expect.objectContaining({ stops: [expect.objectContaining({ studentId: child.id })] }),
    }), { transaction });
  });
  test('rejects the same driver or vehicle scheduled for the same start time', async () => {
    models.Trip.findAll.mockImplementation(async ({ where }) => where.scheduledTime ? [trip] : []);
    const res = response();
    await trips.create(req(payload), res);
    expect(res.statusCode).toBe(409);
    expect(models.Trip.create).not.toHaveBeenCalled();
  });
  test('recurring schedules skip resource conflicts and create remaining ready dates', async () => {
    models.Trip.findAll.mockImplementation(async ({ where }) => where.scheduledTime && where.status ? [trip] : []);
    const res = response();
    await trips.create(req({ ...payload, recurrence: { frequency: 'daily', endDate: '2099-11-23' } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.json.mock.calls[0][0].conflicts).toEqual([expect.objectContaining({ resourceConflict: true })]);
    expect(models.Trip.bulkCreate.mock.calls[0][0].some(value => value.scheduledDate === trip.scheduledDate)).toBe(false);
  });
  test('a fully conflicted recurrence reports conflicts rather than claiming duplicates were already scheduled', async () => {
    models.Trip.findAll.mockImplementation(async ({ where }) => where.scheduledTime && where.status ? [trip] : []);
    const res = response();
    await trips.create(req({ ...payload, recurrence: { frequency: 'daily', endDate: payload.scheduledDate } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.json.mock.calls[0][0].message).toContain('resource conflicts');
    expect(res.json.mock.calls[0][0].count).toBe(0);
  });
  test('untimed legacy trips are constrained to their school-local date across UTC midnight', () => {
    const now = atSchool('2026-11-20T00:05:00');
    expect(schoolDate(now)).toBe('2026-11-20');
    expect(isStartWindowEarly({ scheduledDate: '2026-11-21', scheduledTime: null }, now)).toBe(true);
    expect(isStartWindowLapsed({ scheduledDate: '2026-11-19', scheduledTime: null }, now)).toBe(true);
    expect(isStartWindowEarly({ scheduledDate: '2026-11-20' }, now)).toBe(false);
    expect(isStartWindowLapsed({ scheduledDate: '2026-11-20' }, now)).toBe(false);
    const timed = { scheduledDate: '2026-11-20', scheduledTime: '00:10:00' };
    expect(isStartWindowEarly(timed, tripStartMs(timed) - 20 * 60000)).toBe(false);
    expect(isStartWindowEarly(timed, tripStartMs(timed) - 20 * 60000 - 1)).toBe(true);
  });
  test('workflow rejects a future untimed legacy departure before roster/resource changes', async () => {
    trip.status = 'scheduled';
    trip.scheduledTime = null;
    await expect(workflow.startTrip(trip.id, actor)).rejects.toMatchObject({ status: 400 });
    expect(trip.update).not.toHaveBeenCalled();
  });
});

describe('absence review and attributed staff reconciliation', () => {
  test('parent submissions persist a pending request even without a driver, and never write attendance', async () => {
    child.routes = [];
    models.AbsenceRequest.findOne.mockResolvedValue(null);
    const res = response();
    await messages.reportAbsence(req({ studentId: child.id, date: trip.scheduledDate, reason: 'Family request' }, parent), res);
    expect(res.statusCode).toBe(201);
    expect(models.AbsenceRequest.create).toHaveBeenCalledWith(expect.objectContaining({ studentId: child.id, parentId: parent.id }), { transaction });
    expect(models.TripLog.create).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].notifications).toBe(0);
  });
  test('repeat submissions do not duplicate requests or driver messages', async () => {
    child.routes = [{ schoolId: 1, driver: { id: 12, schoolId: 1, isActive: true } }];
    const res = response();
    await messages.reportAbsence(req({ studentId: child.id, date: trip.scheduledDate }, parent), res);
    expect(res.statusCode).toBe(201);
    expect(models.AbsenceRequest.create).not.toHaveBeenCalled();
    expect(models.Message.create).not.toHaveBeenCalled();
  });
  test('does not accept unowned or inactive children', async () => {
    models.Student.findAll.mockResolvedValue([]);
    const res = response();
    await messages.reportAbsence(req({ studentId: child.id }, parent), res);
    expect(res.statusCode).toBe(404);
    expect(models.AbsenceRequest.create).not.toHaveBeenCalled();
  });
  test('confirmation and attendance/outbox writes share one transaction and record the staff actor', async () => {
    const res = response();
    await absences.confirm(req({ tripId: trip.id, notes: 'Verified with parent' }, actor, absence.id), res);
    expect(res.statusCode).toBe(200);
    expect(models.sequelize.transaction).toHaveBeenCalledTimes(1);
    expect(models.TripLog.create).toHaveBeenCalledWith(expect.objectContaining({
      studentId: child.id, action: 'absent', recordedById: actor.id, idempotencyKey: 'absence:60:trip:30',
    }), { transaction });
    expect(absence.confirmedTripIds).toEqual([30]);
    const { enqueueNotification } = require('../services/notificationOutbox');
    expect(enqueueNotification).toHaveBeenCalledWith(expect.any(Object), transaction);
  });
  test('confirmation retries are idempotent and separate afternoon trips remain confirmable', async () => {
    const body = { tripId: trip.id, notes: 'Verified again' };
    await absences.confirm(req(body, actor, absence.id), response());
    await absences.confirm(req(body, actor, absence.id), response());
    expect(models.TripLog.create).toHaveBeenCalledTimes(1);
    trip.id = 31;
    trip.type = 'afternoon_dropoff';
    trip.plan = buildTripPlan(trip, route, route.routeWaypoints);
    await absences.confirm(req({ ...body, tripId: 31 }, actor, absence.id), response());
    expect(models.TripLog.create).toHaveBeenCalledTimes(2);
    expect(absence.confirmedTripIds).toEqual([30, 31]);
  });
  test.each(['foreign school', 'wrong date', 'rejected', 'inactive trip', 'boarded', 'dropped off', 'changed parent'])('rejects an unsafe confirmation: %s', async problem => {
    if (problem === 'foreign school') absence.schoolId = 2;
    if (problem === 'wrong date') absence.date = '2099-11-21';
    if (problem === 'rejected') absence.status = 'rejected';
    if (problem === 'inactive trip') trip.status = 'completed';
    if (problem === 'changed parent') child.parentId = 99;
    if (problem === 'boarded' || problem === 'dropped off') models.TripLog.findAll.mockResolvedValue([
      { id: 1, studentId: child.id, action: problem === 'boarded' ? 'check_in' : 'check_out', phase: problem === 'boarded' ? 'pickup' : 'dropoff' },
    ]);
    const res = response();
    await absences.confirm(req({ tripId: trip.id, notes: 'Reviewed' }, actor, absence.id), res);
    expect([404, 409]).toContain(res.statusCode);
    expect(models.TripLog.create).not.toHaveBeenCalled();
    expect(absence.update).not.toHaveBeenCalled();
  });
  test('reviews require notes and rejection never rewrites existing attendance', async () => {
    const missing = response();
    await absences.confirm(req({ tripId: trip.id }, actor, absence.id), missing);
    expect(missing.statusCode).toBe(400);
    const rejected = response();
    await absences.reject(req({ notes: 'Parent corrected the request' }, actor, absence.id), rejected);
    expect(rejected.statusCode).toBe(200);
    expect(models.TripLog.create).not.toHaveBeenCalled();
    absence.status = 'confirmed';
    absence.confirmedTripIds = [30];
    const recorded = response();
    await absences.reject(req({ notes: 'Discard it' }, actor, absence.id), recorded);
    expect(recorded.statusCode).toBe(409);
  });
  test('the queue remains school scoped and exposes morning confirmation plus afternoon follow-up', async () => {
    absence.status = 'confirmed';
    absence.confirmedTripIds = [30];
    const afternoon = row({ ...trip.toJSON(), id: 31, type: 'afternoon_dropoff' });
    models.Trip.findAll.mockResolvedValue([trip, afternoon]);
    const res = response();
    await absences.getAll(req(), res);
    expect(res.statusCode).toBe(200);
    expect(models.AbsenceRequest.findAndCountAll.mock.calls[0][0].where).toEqual({ schoolId: 1 });
    expect(res.json.mock.calls[0][0].requests[0].matchingTrips).toEqual([
      expect.objectContaining({ id: 30, confirmed: true }), expect.objectContaining({ id: 31, canConfirm: true }),
    ]);
  });
  test('upcoming parent access follows current ownership, not a stale planned snapshot', async () => {
    const { getAccessibleTrip } = require('../services/tripAccess');
    trip.status = 'scheduled';
    child.parentId = 99;
    models.ParentSchool.findOne.mockResolvedValue({ isActive: true });
    models.Student.findAll.mockImplementation(async ({ where }) => where.parentId === child.parentId ? [child] : []);
    expect(await getAccessibleTrip(trip.id, { id: 99, role: 'parent' })).toMatchObject({ studentIds: [child.id] });
    expect(models.Student.findAll.mock.calls[0][0].include).toEqual([expect.objectContaining({ as: 'routes', required: true })]);
    trip.status = 'in_progress';
    expect(await getAccessibleTrip(trip.id, { id: 99, role: 'parent' })).toBeNull();
  });
  test('absence confirmation refuses a parent mismatch with the active frozen roster', async () => {
    child.parentId = 99;
    absence.parentId = 99;
    const res = response();
    await absences.confirm(req({ tripId: trip.id, notes: 'Verify linkage first' }, actor, absence.id), res);
    expect(res.statusCode).toBe(409);
    expect(models.TripLog.create).not.toHaveBeenCalled();
  });
  test('staff cannot reconcile or inspect a trip whose frozen school conflicts with its current route', async () => {
    trip.plan.schoolId = 2;
    await expect(workflow.logStudentAction(trip.id, actor, { studentId: child.id, action: 'absent' })).rejects.toMatchObject({ status: 404 });
    const res = response();
    await trips.getDetails(req({}, actor, trip.id), res);
    expect(res.statusCode).toBe(404);
    expect(models.TripLog.create).not.toHaveBeenCalled();
  });
  test('absence endpoints deny parent access even with a privileged stale JWT', async () => {
    const secret = process.env.JWT_SECRET || 'operations-tests-only';
    models.User.findByPk.mockResolvedValue(parent);
    const app = express();
    app.use(express.json());
    app.use('/absences', require('../routes/absences'));
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = secret;
    try {
      const token = jwt.sign({ ...parent, role: 'school_admin' }, secret);
      const res = await request(app).get('/absences').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(models.AbsenceRequest.findAndCountAll).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previous;
    }
  });
});
