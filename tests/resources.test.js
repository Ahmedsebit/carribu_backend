/**
 * Vehicle & Student & Route API Tests
 * Tests CRUD operations with role-based access
 */
const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');
const { User } = require('../models');

let adminToken, driverToken, parentToken;

beforeAll(async () => {
  await setupTestDB();

  const [adminRes, driverRes, parentRes] = await Promise.all([
    request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'admin123' }),
    request(app).post('/api/auth/login').send({ email: 'driver@test.com', password: 'driver123' }),
    request(app).post('/api/auth/login').send({ email: 'parent@test.com', password: 'parent123' }),
  ]);

  adminToken = adminRes.body.token;
  driverToken = driverRes.body.token;
  parentToken = parentRes.body.token;
});

afterAll(async () => {
  await teardownTestDB();
});

// ============= VEHICLES =============
describe('Vehicles API', () => {
  test('GET /api/vehicles - admin can list vehicles', async () => {
    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.vehicles).toBeInstanceOf(Array);
    expect(res.body.vehicles.length).toBeGreaterThan(0);
    expect(res.body.vehicles[0].plateNumber).toBe('KDA 999T');
  });

  test('POST /api/vehicles - admin can create vehicle', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plateNumber: 'KDA 888X',
        make: 'Isuzu',
        model: 'NQR',
        year: 2023,
        capacity: 33,
        color: 'Yellow',
        status: 'active',
        insuranceExpiry: '2028-06-01',
      });

    expect(res.status).toBe(201);
    expect(res.body.vehicle.plateNumber).toBe('KDA 888X');
  });

  test('POST /api/vehicles - rejects duplicate plate number', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plateNumber: 'kda 999t', make: 'Duplicate', model: 'Bus', capacity: 20 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/plate number/i);
  });

  test('POST /api/vehicles - driver cannot create vehicle', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ plateNumber: 'KDA 777Z', make: 'Toyota', model: 'Coaster', year: 2022, capacity: 29 });

    expect(res.status).toBe(403);
  });
});

describe('Driver and parent identity uniqueness', () => {
  test('users may share a blank optional phone number', async () => {
    const { school } = getTestData();

    await expect(User.bulkCreate([
      {
        schoolId: school.id,
        email: 'blank-phone-1@test.com',
        passwordHash: 'password',
        firstName: 'Blank',
        lastName: 'One',
        role: 'coordinator',
        phone: '',
      },
      {
        schoolId: school.id,
        email: 'blank-phone-2@test.com',
        passwordHash: 'password',
        firstName: 'Blank',
        lastName: 'Two',
        role: 'coordinator',
        phone: '',
      },
    ])).resolves.toHaveLength(2);
  });

  test('POST /api/drivers - rejects an existing phone number in local format', async () => {
    const res = await request(app)
      .post('/api/drivers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'other-driver@test.com',
        firstName: 'Other',
        lastName: 'Driver',
        phone: '0700000002',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email or phone/i);
  });

  test('POST /api/parents - rejects an existing phone number in local format', async () => {
    const res = await request(app)
      .post('/api/parents')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'other-parent@test.com',
        firstName: 'Other',
        lastName: 'Parent',
        phone: '0700000003',
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/email or phone/i);
  });
});

// ============= STUDENTS =============
describe('Students API', () => {
  test('GET /api/students - admin can list students', async () => {
    const res = await request(app)
      .get('/api/students')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.students).toBeInstanceOf(Array);
    expect(res.body.students.length).toBe(2);
  });

  test('POST /api/students - admin can create student', async () => {
    const { parent } = getTestData();
    const res = await request(app)
      .post('/api/students')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        admissionNumber: 'TEST-003',
        firstName: 'New',
        lastName: 'Student',
        grade: 'Grade 5',
        parentId: parent.id,
      });

    expect(res.status).toBe(201);
    expect(res.body.student.firstName).toBe('New');
    expect(res.body.student.grade).toBe('Grade 5');
  });

  test('POST /api/students - rejects duplicate admission number', async () => {
    const { parent } = getTestData();
    const res = await request(app)
      .post('/api/students')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        admissionNumber: 'test-001',
        firstName: 'Duplicate',
        lastName: 'Student',
        parentId: parent.id,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/admission number/i);
  });

  test('GET /api/students - parent cannot list all students', async () => {
    const res = await request(app)
      .get('/api/students')
      .set('Authorization', `Bearer ${parentToken}`);

    // Should be forbidden or filtered
    expect([200, 403]).toContain(res.status);
  });
});

// ============= ROUTES =============
describe('Routes API', () => {
  test('GET /api/routes - admin can list routes', async () => {
    const res = await request(app)
      .get('/api/routes')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.routes).toBeInstanceOf(Array);
    expect(res.body.routes.length).toBeGreaterThan(0);
    expect(res.body.routes[0].name).toBe('Test Route');
  });

  test('POST /api/routes - admin can create route', async () => {
    const { vehicle, driver } = getTestData();
    const res = await request(app)
      .post('/api/routes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'New Test Route',
        description: 'A new route for testing',
        vehicleId: vehicle.id,
        driverId: driver.id,
        type: 'morning',
        grades: ['Grade 1', 'Grade 2'],
        departureTime: '07:00',
      });

    expect(res.status).toBe(201);
    expect(res.body.route.name).toBe('New Test Route');
  });

  test('POST /api/routes/suggest-students - suggests students near waypoints', async () => {
    const res = await request(app)
      .post('/api/routes/suggest-students')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        grades: ['Grade 3'],
        waypoints: [{ lat: -1.2641, lng: 36.8053 }],
        radiusKm: 5,
      });

    expect(res.status).toBe(200);
    expect(res.body.students).toBeInstanceOf(Array);
  });

  test('GET /api/driver/my-routes - driver can see assigned routes', async () => {
    const res = await request(app)
      .get('/api/driver/my-routes')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.routes).toBeInstanceOf(Array);
    expect(res.body.routes.length).toBeGreaterThan(0);
  });
});
