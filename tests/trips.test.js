/**
 * Trip Lifecycle Tests
 * Tests trip creation, starting, pickup actions, and completion
 */
const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');

let adminToken, driverToken, parentToken;
let tripId;
let conflictingTripId;

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

describe('Trip Lifecycle', () => {
  test('POST /api/trips - admin can create a trip', async () => {
    const { route, driver, vehicle } = getTestData();
    const today = new Date().toISOString().split('T')[0];

    const res = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        routeId: route.id,
        driverId: driver.id,
        vehicleId: vehicle.id,
        type: 'morning_pickup',
        scheduledDate: today,
      });

    expect(res.status).toBe(201);
    expect(res.body.trip).toBeDefined();
    expect(res.body.trip.status).toBe('scheduled');
    tripId = res.body.trip.id;
  });

  test('GET /api/trips - admin can list trips', async () => {
    const res = await request(app)
      .get('/api/trips')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.trips).toBeInstanceOf(Array);
    expect(res.body.trips.length).toBeGreaterThan(0);
  });

  test('GET /api/driver/my-trips - driver can see their trips', async () => {
    const res = await request(app)
      .get('/api/driver/my-trips')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.trips).toBeInstanceOf(Array);
    expect(res.body.trips.length).toBeGreaterThan(0);
  });

  test('POST /api/trips/:id/start - driver can start trip', async () => {
    const res = await request(app)
      .put(`/api/trips/${tripId}/start`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.trip.status).toBe('in_progress');
    expect(res.body.trip.startedAt).toBeDefined();
  });

  test('PUT /api/trips/:id/start - rejects students already assigned to an active trip', async () => {
    const { route } = getTestData();
    const today = new Date().toISOString().split('T')[0];
    const created = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ routeId: route.id, type: 'morning_pickup', scheduledDate: today });

    expect(created.status).toBe(201);
    conflictingTripId = created.body.trip.id;

    const res = await request(app)
      .put(`/api/trips/${conflictingTripId}/start`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already assigned to an active trip/i);
    expect(res.body.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ activeTripId: tripId }),
    ]));
  });

  test('PUT /api/trips/:id/start - cannot start already started trip', async () => {
    const res = await request(app)
      .put(`/api/trips/${tripId}/start`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(400);
  });

  test('POST /api/trips/:id/log - driver can mark arrived', async () => {
    const { student1 } = getTestData();
    const res = await request(app)
      .post(`/api/trips/${tripId}/log`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        studentId: student1.id,
        action: 'arrived',
        lat: -1.2641,
        lng: 36.8053,
      });

    expect(res.status).toBe(201);
    expect(res.body.log.action).toBe('arrived');
  });

  test('POST /api/trips/:id/log - driver can check in student', async () => {
    const { student1 } = getTestData();
    const res = await request(app)
      .post(`/api/trips/${tripId}/log`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        studentId: student1.id,
        action: 'check_in',
        lat: -1.2641,
        lng: 36.8053,
      });

    expect(res.status).toBe(201);
    expect(res.body.log.action).toBe('check_in');
  });

  test('POST /api/trips/:id/log - driver can mark student absent', async () => {
    const { student2 } = getTestData();
    const res = await request(app)
      .post(`/api/trips/${tripId}/log`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        studentId: student2.id,
        action: 'absent',
        notes: 'Parent reported sick',
      });

    expect(res.status).toBe(201);
    expect(res.body.log.action).toBe('absent');
  });

  test('PUT /api/trips/:id/end - driver can end trip', async () => {
    const res = await request(app)
      .put(`/api/trips/${tripId}/end`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.trip.status).toBe('completed');
    expect(res.body.trip.endedAt).toBeDefined();
  });

  test('PUT /api/trips/:id/end - cannot end already completed trip', async () => {
    const res = await request(app)
      .put(`/api/trips/${tripId}/end`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(400);
  });
});

describe('Trip Access Control', () => {
  test('parent cannot create trips', async () => {
    const { route, driver, vehicle } = getTestData();
    const res = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        routeId: route.id,
        driverId: driver.id,
        vehicleId: vehicle.id,
        type: 'morning_pickup',
        scheduledDate: '2026-06-01',
      });

    expect(res.status).toBe(403);
  });

  test('parent cannot start trips', async () => {
    const res = await request(app)
      .put(`/api/trips/${tripId}/start`)
      .set('Authorization', `Bearer ${parentToken}`);

    expect(res.status).toBe(403);
  });
});
