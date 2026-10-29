const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');

jest.mock('../models', () => ({
  School: { findByPk: jest.fn() },
  User: { findByPk: jest.fn(), findAll: jest.fn() },
  ParentSchool: { findAll: jest.fn() },
  Student: { findAll: jest.fn() },
  Route: { findAll: jest.fn() },
  Trip: { findAll: jest.fn() },
  Vehicle: { findOne: jest.fn(), findAll: jest.fn(), create: jest.fn() },
}));
jest.mock('../services/superAdminDeletion', () => ({
  deleteSchool: jest.fn(), deleteSchoolResource: jest.fn(),
}));
jest.mock('../services/superAdminTrips', () => ({ endSchoolTrip: jest.fn() }));
jest.mock('../utils/email', () => ({ sendPasswordResetEmail: jest.fn() }));
jest.mock('../socket', () => ({ notifyTrip: jest.fn() }));

const { Vehicle, User, School, ParentSchool, Student, Route, Trip } = require('../models');
const app = express();
app.use(express.json());
app.use('/api/super-admin', require('../routes/superAdmin'));
app.use('/api/vehicles', require('../routes/vehicles'));

const endpoint = '/api/super-admin/schools/1/vehicles/12/tracker';
const testSecret = 'vehicle-tracker-assignment-test-secret';
let originalSecret;
let vehicles;
const token = role => jwt.sign({ id: 8, role, schoolId: 1 }, testSecret);
const assign = (body, url = endpoint) => request(app).put(url)
  .set('Authorization', `Bearer ${token('super_admin')}`).send(body);

beforeAll(() => {
  originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = testSecret;
});

afterAll(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

beforeEach(() => {
  jest.resetAllMocks();
  vehicles = [
    { id: 12, schoolId: 1, plateNumber: 'TEST 001', status: 'active', trackerUniqueId: 'old-device' },
    { id: 13, schoolId: 2, plateNumber: 'TEST 002', status: 'active', trackerUniqueId: 'other-school-device' },
  ].map(vehicle => ({
    ...vehicle,
    update: jest.fn(async function update(values) {
      Object.assign(this, values);
      return this;
    }),
  }));
  User.findByPk.mockResolvedValue({ id: 8, isActive: true });
  User.findAll.mockResolvedValue([]);
  School.findByPk.mockImplementation(async id => ({ id: Number(id), name: 'Test school' }));
  for (const model of [ParentSchool, Student, Route, Trip]) model.findAll.mockResolvedValue([]);
  Vehicle.findOne.mockImplementation(async ({ where }) => vehicles.find(vehicle =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && value[Op.ne] !== undefined) {
        return vehicle[key] !== value[Op.ne];
      }
      if (key === 'id' || key === 'schoolId') return vehicle[key] === Number(value);
      return vehicle[key] === value;
    })) || null);
  Vehicle.findAll.mockImplementation(async ({ where }) => vehicles.filter(vehicle => vehicle.schoolId === where.schoolId));
  Vehicle.create.mockImplementation(async values => ({ id: 14, ...values }));
});

describe('super-admin-only tracker assignments', () => {
  test('requires authentication', async () => {
    const response = await request(app).put(endpoint).send({ trackerUniqueId: 'device' });
    expect(response.status).toBe(401);
    expect(Vehicle.findOne).not.toHaveBeenCalled();
  });

  test.each(['school_admin', 'coordinator', 'driver', 'parent'])('rejects %s on the platform endpoint', async role => {
    const response = await request(app).put(endpoint)
      .set('Authorization', `Bearer ${token(role)}`).send({ trackerUniqueId: 'device' });
    expect(response.status).toBe(403);
    expect(Vehicle.findOne).not.toHaveBeenCalled();
  });

  test('links and replaces identifiers while preserving vehicle status and school', async () => {
    const response = await assign({ trackerUniqueId: ' 012345678901234 ' });
    expect(response.status).toBe(200);
    expect(response.body.vehicle.trackerUniqueId).toBe('012345678901234');
    expect(vehicles[0].trackerUniqueId).toBe('012345678901234');
    expect(vehicles[0].update).toHaveBeenCalledWith({ trackerUniqueId: '012345678901234' });
    expect(vehicles[0].schoolId).toBe(1);
    expect(vehicles[0].status).toBe('active');
    const replacement = await assign({ trackerUniqueId: 'replacement-device' });
    expect(replacement.status).toBe(200);
    expect(vehicles[0].trackerUniqueId).toBe('replacement-device');
  });

  test.each([null, '', '   '])('unlinks using %p', async trackerUniqueId => {
    const response = await assign({ trackerUniqueId });
    expect(response.status).toBe(200);
    expect(response.body.message).toBe('GPS tracker unlinked.');
    expect(vehicles[0].trackerUniqueId).toBeNull();
  });

  test('does not silently activate a maintenance vehicle', async () => {
    vehicles[0].status = 'maintenance';
    const response = await assign({ trackerUniqueId: 'device' });
    expect(response.status).toBe(200);
    expect(vehicles[0].status).toBe('maintenance');
    expect(Trip.findAll).not.toHaveBeenCalled();
  });

  test('allows keeping the same tracker on the same vehicle', async () => {
    const response = await assign({ trackerUniqueId: 'old-device' });
    expect(response.status).toBe(200);
    expect(vehicles[0].trackerUniqueId).toBe('old-device');
  });

  test('cannot update a vehicle through a different school URL', async () => {
    const response = await assign({ trackerUniqueId: 'device' }, '/api/super-admin/schools/1/vehicles/13/tracker');
    expect(response.status).toBe(404);
    expect(vehicles[1].update).not.toHaveBeenCalled();
  });

  test('rejects identifiers assigned to vehicles in another school', async () => {
    const response = await assign({ trackerUniqueId: 'other-school-device' });
    expect(response.status).toBe(409);
    expect(vehicles[0].update).not.toHaveBeenCalled();
    expect(vehicles[0].trackerUniqueId).toBe('old-device');
  });

  test('handles a database uniqueness conflict during a concurrent assignment', async () => {
    vehicles[0].update.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), {
      name: 'SequelizeUniqueConstraintError',
    }));
    const response = await assign({ trackerUniqueId: 'new-device' });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('This tracker is already assigned to another vehicle.');
  });

  test.each([
    {}, { trackerUniqueId: 123 }, { trackerUniqueId: {} }, { trackerUniqueId: [] },
    { trackerUniqueId: 'x'.repeat(129) }, { trackerUniqueId: 'device', status: 'active' },
    { trackerUniqueId: 'device', schoolId: 2 },
  ])('rejects invalid payload %p without updating a vehicle', async body => {
    const response = await assign(body);
    expect(response.status).toBe(400);
    expect(Vehicle.findOne).not.toHaveBeenCalled();
  });

  test('rejects a missing request body', async () => {
    const response = await assign(undefined);
    expect(response.status).toBe(400);
    expect(Vehicle.findOne).not.toHaveBeenCalled();
  });

  test.each(['0', '-1', 'invalid', '1.5'])('rejects invalid school ID %s', async id => {
    const response = await assign({ trackerUniqueId: 'device' }, `/api/super-admin/schools/${id}/vehicles/12/tracker`);
    expect(response.status).toBe(400);
    expect(Vehicle.findOne).not.toHaveBeenCalled();
  });

  test('returns an explicit error on persistence failure', async () => {
    vehicles[0].update.mockRejectedValueOnce(new Error('Database unavailable.'));
    const response = await assign({ trackerUniqueId: 'device' });
    expect(response.status).toBe(500);
    expect(response.body.error).toBe('Database unavailable.');
  });

  test('includes existing tracker assignments in school vehicle resources', async () => {
    const response = await request(app).get('/api/super-admin/schools/1/resources')
      .set('Authorization', `Bearer ${token('super_admin')}`);
    expect(response.status).toBe(200);
    expect(response.body.resources.vehicles[0].trackerUniqueId).toBe('old-device');
    expect(Vehicle.findAll).toHaveBeenCalledWith(expect.objectContaining({
      where: { schoolId: 1 }, attributes: expect.arrayContaining(['trackerUniqueId']),
    }));
  });

  test.each(['school_admin', 'coordinator'])('blocks %s from assigning or clearing trackers through ordinary vehicle writes', async role => {
    for (const trackerUniqueId of ['new-device', null, '']) {
      const create = await request(app).post('/api/vehicles')
        .set('Authorization', `Bearer ${token(role)}`).send({ plateNumber: 'TEST 003', trackerUniqueId });
      const update = await request(app).put('/api/vehicles/12')
        .set('Authorization', `Bearer ${token(role)}`).send({ trackerUniqueId });
      expect(create.status).toBe(403);
      expect(update.status).toBe(403);
    }
    expect(Vehicle.create).not.toHaveBeenCalled();
    expect(vehicles[0].update).not.toHaveBeenCalled();
  });

  test('keeps ordinary vehicle creation and edits working without changing tracker links', async () => {
    const create = await request(app).post('/api/vehicles')
      .set('Authorization', `Bearer ${token('school_admin')}`)
      .send({ plateNumber: 'test 003', capacity: 20 });
    expect(create.status).toBe(201);
    expect(Vehicle.create).toHaveBeenCalledWith({ plateNumber: 'TEST 003', capacity: 20, schoolId: 1 });
    const update = await request(app).put('/api/vehicles/12')
      .set('Authorization', `Bearer ${token('coordinator')}`).send({ capacity: 25 });
    expect(update.status).toBe(200);
    expect(vehicles[0].trackerUniqueId).toBe('old-device');
    expect(vehicles[0].update).toHaveBeenCalledWith({ capacity: 25 });
  });
});
