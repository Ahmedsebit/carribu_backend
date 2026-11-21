const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');

jest.mock('../models', () => ({
  sequelize: { transaction: jest.fn(), query: jest.fn() },
  School: { findByPk: jest.fn(), findAll: jest.fn(), create: jest.fn() },
  User: { findByPk: jest.fn(), findOne: jest.fn(), create: jest.fn(), count: jest.fn() },
  Vehicle: { findOne: jest.fn(), create: jest.fn(), count: jest.fn() },
  Student: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn(), count: jest.fn() },
  ParentSchool: { findOne: jest.fn(), findAll: jest.fn() },
  Route: { findOne: jest.fn(), findByPk: jest.fn(), create: jest.fn(), count: jest.fn() },
  Trip: { findByPk: jest.fn(), count: jest.fn(), update: jest.fn() },
  TripLog: { findAll: jest.fn() },
  RouteStudent: { destroy: jest.fn(), bulkCreate: jest.fn(), findAll: jest.fn() },
  RouteWaypoint: { findOne: jest.fn(), bulkCreate: jest.fn(), destroy: jest.fn() },
}));
jest.mock('../middleware/auditLog', () => ({ logLogin: jest.fn() }));
jest.mock('../services/tripWorkflow', () => ({ lockSchool: jest.fn(), refreshFuturePlans: jest.fn() }));
jest.mock('../services/locationTracking', () => ({}));
jest.mock('../services/tripReminders', () => ({}));
jest.mock('../socket', () => ({ notifyTrip: jest.fn() }));
jest.mock('../utils/email', () => ({ sendPasswordResetEmail: jest.fn() }));
jest.mock('../services/superAdminDeletion', () => ({}));
jest.mock('../services/superAdminTrips', () => ({}));

const models = require('../models');
const { authenticate, authorize } = require('../middleware/auth');
const { getAccessibleTrip } = require('../services/tripAccess');
const platform = require('../controllers/superAdminController');
const app = express();
app.use(express.json());
app.use('/auth', require('../routes/auth'));
app.use('/schools', require('../routes/schools'));
app.use('/vehicles', require('../routes/vehicles'));
app.use('/students', require('../routes/students'));
app.use('/routes', require('../routes/routes'));
app.use('/trips', require('../routes/trips'));
app.post('/platform/admins', authenticate, authorize('super_admin'), platform.createSchoolAdmin);
const secret = 'authorization-tests-only';
let originalSecret, users, school, route, vehicle, student, trip, transaction;
const token = (id = 1, claims = {}) => jwt.sign({ ...users.get(id), ...claims }, secret);
const auth = (method, url, id = 1, claims = {}) => request(app)[method](url)
  .set('Authorization', `Bearer ${token(id, claims)}`);
const registration = { email: 'synthetic@example.test', password: 'test-only-password', firstName: 'Test', lastName: 'Parent' };

beforeAll(() => { originalSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret; });
afterAll(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});
beforeEach(() => {
  jest.resetAllMocks();
  require('../services/tripWorkflow').refreshFuturePlans.mockResolvedValue([]);
  users = new Map([
    [1, { id: 1, role: 'school_admin', schoolId: 4, isActive: true }],
    [2, { id: 2, role: 'super_admin', schoolId: null, isActive: true }],
    [3, { id: 3, role: 'driver', schoolId: 4, isActive: true }],
    [5, { id: 5, role: 'parent', schoolId: 99, isActive: true }],
    [6, { id: 6, role: 'driver', schoolId: 4, isActive: true }],
    [7, { id: 7, role: 'coordinator', schoolId: 4, isActive: true }],
  ]);
  models.User.findByPk.mockImplementation(async id => users.get(id));
  models.User.findOne.mockResolvedValue(null);
  models.User.create.mockImplementation(async data => ({ ...data, id: 100 }));
  school = { id: 4, vehicles: [], students: [], routes: [], update: jest.fn(), toJSON: () => ({ id: 4 }) };
  models.School.findByPk.mockResolvedValue(school);
  models.School.findAll.mockResolvedValue([school]);
  models.School.create.mockResolvedValue(school);
  vehicle = { id: 8, schoolId: 4, update: jest.fn() };
  student = { id: 11, schoolId: 4, update: jest.fn() };
  route = {
    id: 9, schoolId: 4, driverId: 3, vehicleId: 8, students: [],
    update: jest.fn(async data => Object.assign(route, data)),
    toJSON: () => ({ id: 9, students: [] }),
  };
  models.Vehicle.findOne.mockResolvedValue(vehicle);
  models.Student.findOne.mockResolvedValue(student);
  models.Student.findAll.mockResolvedValue([{ id: 11 }]);
  models.ParentSchool.findOne.mockResolvedValue({ id: 1, schoolId: 4 });
  models.Route.findOne.mockResolvedValue(route);
  models.Route.findByPk.mockResolvedValue(route);
  models.Route.create.mockResolvedValue(route);
  models.Trip.count.mockResolvedValue(0);
  trip = { id: 10, routeId: 9, driverId: 3, route, plan: { stops: [{ studentId: 11, parentId: 5 }] } };
  models.Trip.findByPk.mockResolvedValue(trip);
  models.TripLog.findAll.mockResolvedValue([{ id: 1, studentId: 11 }]);
  transaction = { LOCK: { UPDATE: 'UPDATE' } };
  models.sequelize.transaction.mockImplementation(operation => operation(transaction));
  for (const model of [models.User, models.Vehicle, models.Student, models.Route]) model.count.mockResolvedValue(1);
});

describe('public versus authorised provisioning', () => {
  test.each(['school_admin', 'super_admin', 'coordinator', 'driver', 'unexpected'])('rejects public role %s before writes', async role => {
    expect((await request(app).post('/auth/register').send({ ...registration, role })).status).toBe(403);
    expect(models.User.create).not.toHaveBeenCalled();
  });
  test.each([{}, { role: 'parent' }])('creates only an unlinked parent account: %p', async extra => {
    const res = await request(app).post('/auth/register').send({ ...registration, ...extra });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ role: 'parent', schoolId: null, mustSetPassword: true });
    expect(res.body.token).toBeUndefined();
  });
  test('rejects public school enrollment instead of triggering the membership hook', async () => {
    expect((await request(app).post('/auth/register').send({ ...registration, schoolId: 4 })).status).toBe(403);
    expect(models.User.create).not.toHaveBeenCalled();
  });
  test('preserves school-admin provisioning exclusively through a platform administrator', async () => {
    const body = { ...registration, schoolId: 4 };
    expect((await auth('post', '/platform/admins').send(body)).status).toBe(403);
    expect(models.User.create).not.toHaveBeenCalled();
    expect((await auth('post', '/platform/admins', 2).send(body)).status).toBe(201);
    expect(models.User.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'school_admin', schoolId: 4 }));
  });
});

describe('school boundaries', () => {
  test.each([
    ['get', '/schools/99'], ['get', '/schools/99/dashboard'],
    ['put', '/schools/99'], ['delete', '/schools/99'],
  ])('denies cross-school %s %s before school lookup or counts', async (method, url) => {
    expect((await auth(method, url).send({ name: 'Changed' })).status).toBe(404);
    expect(models.School.findByPk).not.toHaveBeenCalled();
    expect(models.Vehicle.count).not.toHaveBeenCalled();
    expect(school.update).not.toHaveBeenCalled();
  });
  test.each([
    ['get', '/schools/4'], ['get', '/schools/4/dashboard'],
    ['put', '/schools/4'], ['delete', '/schools/4'],
  ])('preserves same-school %s %s', async (method, url) => {
    expect((await auth(method, url).send({ name: 'Changed' })).status).toBe(200);
  });
  test.each([3, 5])('does not disclose school rosters to driver/parent account %s', async id => {
    expect((await auth('get', '/schools/4', id)).status).toBe(403);
    expect(models.School.findByPk).not.toHaveBeenCalled();
  });
  test('allows coordinator reads but not school mutations', async () => {
    expect((await auth('get', '/schools/4', 7)).status).toBe(200);
    expect((await auth('put', '/schools/4', 7).send({ name: 'Changed' })).status).toBe(403);
  });
  test('allows explicit platform school access, but not school-admin school creation', async () => {
    expect((await auth('get', '/schools/99', 2)).status).toBe(200);
    expect((await auth('post', '/schools').send({ name: 'New school' })).status).toBe(403);
    expect((await auth('post', '/schools', 2).send({ name: 'New school' })).status).toBe(201);
  });
  test('uses current account authority instead of privileged or foreign-school JWT claims', async () => {
    const res = await auth('get', '/schools/99', 1, { role: 'super_admin', schoolId: 99 });
    expect(res.status).toBe(404);
    users.get(1).isActive = false;
    expect((await auth('get', '/schools/4')).status).toBe(401);
  });
});

describe('trip logs and parent memberships', () => {
  test('staff can read own-school logs but not foreign-school logs', async () => {
    expect((await auth('get', '/trips/10/logs')).status).toBe(200);
    route.schoolId = 99; models.TripLog.findAll.mockClear();
    expect((await auth('get', '/trips/10/logs')).status).toBe(404);
    expect(models.TripLog.findAll).not.toHaveBeenCalled();
    expect((await auth('get', '/trips/10/logs', 2)).status).toBe(200);
  });
  test('drivers must be assigned to the trip, not merely to the school', async () => {
    expect((await auth('get', '/trips/10/logs', 6)).status).toBe(404);
    expect(models.TripLog.findAll).not.toHaveBeenCalled();
    expect((await auth('get', '/trips/10/logs', 3)).status).toBe(200);
  });
  test('multi-school parent access uses active membership and filters logs to their frozen roster children', async () => {
    const res = await auth('get', '/trips/10/logs', 5);
    expect(res.status).toBe(200);
    expect(models.ParentSchool.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { parentId: 5, schoolId: 4, isActive: true },
    }));
    expect(models.Student.findAll).toHaveBeenCalledWith(expect.objectContaining({
      where: { parentId: 5, schoolId: 4, isActive: true, id: { [Op.in]: [11] } }, include: [],
    }));
    expect(models.TripLog.findAll).toHaveBeenCalledWith(expect.objectContaining({
      where: { tripId: 10, studentId: { [Op.in]: [11] } },
    }));
  });
  test.each(['revoked membership', 'unrelated roster', 'inactive child'])('denies a parent with %s', async reason => {
    if (reason === 'revoked membership') models.ParentSchool.findOne.mockResolvedValue(null);
    if (reason === 'unrelated roster') trip.plan.stops = [{ studentId: 12, parentId: 20 }];
    if (reason === 'inactive child') models.Student.findAll.mockResolvedValue([]);
    expect((await auth('get', '/trips/10/logs', 5)).status).toBe(404);
    expect(models.TripLog.findAll).not.toHaveBeenCalled();
  });
  test('legacy trips require a child assigned to that school-owned route', async () => {
    trip.plan = null;
    expect(await getAccessibleTrip(10, users.get(5))).toMatchObject({ studentIds: [11] });
    expect(models.Student.findAll.mock.calls[0][0].include[0]).toMatchObject({
      as: 'routes', where: { id: 9, schoolId: 4 }, required: true,
    });
  });
  test('does not expose historical data if a route and its frozen school ownership disagree', async () => {
    trip.plan.schoolId = 99;
    expect((await auth('get', '/trips/10/logs')).status).toBe(404);
    expect(models.TripLog.findAll).not.toHaveBeenCalled();
  });
});

describe('immutable tenant fields and route relationships', () => {
  test.each(['vehicles', 'students', 'routes'])('%s rejects ownership and primary-key changes without mutations', async resource => {
    for (const field of ['schoolId', 'school_id', 'id']) {
      expect((await auth('put', `/${resource}/8`).send({ [field]: 99 })).status).toBe(400);
    }
    expect(vehicle.update).not.toHaveBeenCalled();
    expect(student.update).not.toHaveBeenCalled();
    expect(route.update).not.toHaveBeenCalled();
    expect(models.RouteStudent.destroy).not.toHaveBeenCalled();
  });
  test.each([
    ['vehicles', { color: 'Blue' }], ['students', { firstName: 'Updated' }], ['routes', { name: 'Updated' }],
  ])('preserves normal %s updates', async (resource, body) => {
    expect((await auth('put', `/${resource}/8`).send(body)).status).toBe(200);
  });
  test('school administrators cannot change platform-managed school ownership', async () => {
    expect((await auth('put', '/schools/4').send({ managedBy: 99 })).status).toBe(400);
    expect(school.update).not.toHaveBeenCalled();
  });
  test.each(['post', 'put'])('%s route rejects foreign vehicle, driver and student assignments before writes', async method => {
    const url = method === 'post' ? '/routes' : '/routes/9';
    models.Vehicle.findOne.mockResolvedValue(null);
    expect((await auth(method, url).send({ name: 'Route', vehicleId: 99 })).status).toBe(400);
    expect((await auth(method, url).send({ name: 'Route', driverId: 99 })).status).toBe(400);
    models.Student.findAll.mockResolvedValue([]);
    expect((await auth(method, url).send({ name: 'Route', studentIds: [99] })).status).toBe(400);
    expect(models.Route.create).not.toHaveBeenCalled();
    expect(route.update).not.toHaveBeenCalled();
    expect(models.RouteStudent.destroy).not.toHaveBeenCalled();
  });
  test('valid same-school route creation keeps all assignments in its transaction', async () => {
    models.User.findOne.mockResolvedValue({ id: 3 });
    const res = await auth('post', '/routes').send({ name: 'Route', vehicleId: 8, driverId: 3, studentIds: [11] });
    expect(res.status).toBe(201);
    expect(models.Route.create).toHaveBeenCalledWith(expect.objectContaining({ schoolId: 4 }), { transaction });
    expect(models.RouteStudent.bulkCreate).toHaveBeenCalledWith(
      [{ routeId: 9, studentId: 11, stopOrder: 1 }], { transaction },
    );
  });
  test('parent links still require active membership in the student school', async () => {
    models.ParentSchool.findOne.mockResolvedValue(null);
    expect((await auth('put', '/students/11').send({ parentId: 99 })).status).toBe(400);
    expect(student.update).not.toHaveBeenCalled();
  });
});
