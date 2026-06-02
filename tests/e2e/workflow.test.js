/**
 * End-to-End Workflow Test
 * Simulates the complete workflow:
 * 1. Admin creates school resources (vehicle, students, route)
 * 2. Admin creates trip
 * 3. Driver starts trip
 * 4. Driver arrives at stops and picks up students
 * 5. Parent checks tracking data
 * 6. Parent and driver exchange messages
 * 7. Driver completes trip
 */
const request = require('supertest');
const app = require('../testApp');
const { sequelize, School, User, Vehicle, Student, Route, RouteStudent } = require('../../models');

let school, adminToken, driverToken, parent1Token, parent2Token;
let vehicleId, routeId, student1Id, student2Id, driverId, parent1Id, parent2Id;

beforeAll(async () => {
  await sequelize.authenticate();
  await sequelize.sync({ force: true });

  // Step 1: Create school
  school = await School.create({
    name: 'E2E Test School',
    address: '1 Main St',
    city: 'Nairobi',
    phone: '+254700100100',
    email: 'e2e@testschool.co.ke',
  });

  // Step 2: Create users
  const admin = await User.create({
    schoolId: school.id, email: 'e2e-admin@test.com', passwordHash: 'admin123',
    firstName: 'E2E', lastName: 'Admin', role: 'school_admin', phone: '+254700200001',
  });

  const driver = await User.create({
    schoolId: school.id, email: 'e2e-driver@test.com', passwordHash: 'driver123',
    firstName: 'E2E', lastName: 'Driver', role: 'driver', phone: '+254700200002',
  });
  driverId = driver.id;

  const parent1 = await User.create({
    schoolId: school.id, email: 'e2e-parent1@test.com', passwordHash: 'parent123',
    firstName: 'Parent', lastName: 'One', role: 'parent', phone: '+254700200003',
    pickupLat: -1.2641, pickupLng: 36.8053, pickupAddress: 'Westlands',
  });
  parent1Id = parent1.id;

  const parent2 = await User.create({
    schoolId: school.id, email: 'e2e-parent2@test.com', passwordHash: 'parent123',
    firstName: 'Parent', lastName: 'Two', role: 'parent', phone: '+254700200004',
    pickupLat: -1.2888, pickupLng: 36.7845, pickupAddress: 'Kilimani',
  });
  parent2Id = parent2.id;

  // Login all users
  const [aRes, dRes, p1Res, p2Res] = await Promise.all([
    request(app).post('/api/auth/login').send({ email: 'e2e-admin@test.com', password: 'admin123' }),
    request(app).post('/api/auth/login').send({ email: 'e2e-driver@test.com', password: 'driver123' }),
    request(app).post('/api/auth/login').send({ email: 'e2e-parent1@test.com', password: 'parent123' }),
    request(app).post('/api/auth/login').send({ email: 'e2e-parent2@test.com', password: 'parent123' }),
  ]);

  adminToken = aRes.body.token;
  driverToken = dRes.body.token;
  parent1Token = p1Res.body.token;
  parent2Token = p2Res.body.token;
});

afterAll(async () => {
  // Let Jest --forceExit handle cleanup
});

describe('E2E: Complete Trip Workflow', () => {
  // ==================== ADMIN SETUP ====================
  test('Step 1: Admin creates a vehicle', async () => {
    const res = await request(app)
      .post('/api/vehicles')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        plateNumber: 'KDA E2E1',
        make: 'Toyota',
        model: 'HiAce',
        year: 2023,
        capacity: 18,
        color: 'White',
        status: 'active',
        insuranceExpiry: '2028-01-01',
      });

    expect(res.status).toBe(201);
    vehicleId = res.body.vehicle.id;
  });

  test('Step 2: Admin creates students assigned to parents', async () => {
    const res1 = await request(app)
      .post('/api/students')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ firstName: 'Alice', lastName: 'Kamau', grade: 'Grade 3', parentId: parent1Id });

    const res2 = await request(app)
      .post('/api/students')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ firstName: 'Bob', lastName: 'Njoroge', grade: 'Grade 3', parentId: parent2Id });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    student1Id = res1.body.student.id;
    student2Id = res2.body.student.id;
  });

  test('Step 3: Admin creates a route with driver and students', async () => {
    const res = await request(app)
      .post('/api/routes')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'E2E Morning Route',
        description: 'Full e2e test route',
        vehicleId,
        driverId,
        type: 'morning',
        grades: ['Grade 3'],
        departureTime: '06:30',
        studentIds: [student1Id, student2Id],
      });

    expect(res.status).toBe(201);
    routeId = res.body.route.id;
    expect(res.body.route.name).toBe('E2E Morning Route');
  });

  // ==================== TRIP LIFECYCLE ====================
  let tripId;

  test('Step 4: Admin creates a scheduled trip', async () => {
    const today = new Date().toISOString().split('T')[0];
    const res = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        routeId,
        driverId,
        vehicleId,
        type: 'morning_pickup',
        scheduledDate: today,
      });

    expect(res.status).toBe(201);
    tripId = res.body.trip.id;
    expect(res.body.trip.status).toBe('scheduled');
  });

  test('Step 5: Driver sees trip in their list', async () => {
    const res = await request(app)
      .get('/api/driver/my-trips')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    const myTrip = res.body.trips.find(t => t.id === tripId);
    expect(myTrip).toBeDefined();
    expect(myTrip.status).toBe('scheduled');
  });

  test('Step 6: Driver starts the trip', async () => {
    const res = await request(app)
      .put(`/api/trips/${tripId}/start`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.trip.status).toBe('in_progress');
  });

  test('Step 7: Driver updates location', async () => {
    const res = await request(app)
      .post('/api/location/update')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ tripId, lat: -1.2600, lng: 36.8000, speed: 40, heading: 90 });

    expect(res.status).toBe(201);
  });

  test('Step 8: Driver arrives at first student stop', async () => {
    const res = await request(app)
      .post(`/api/trips/${tripId}/log`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ studentId: student1Id, action: 'arrived', lat: -1.2641, lng: 36.8053 });

    expect(res.status).toBe(201);
    expect(res.body.log.action).toBe('arrived');
  });

  test('Step 9: Driver picks up first student', async () => {
    const res = await request(app)
      .post(`/api/trips/${tripId}/log`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ studentId: student1Id, action: 'check_in', lat: -1.2641, lng: 36.8053 });

    expect(res.status).toBe(201);
    expect(res.body.log.action).toBe('check_in');
  });

  test('Step 10: Driver arrives at second student stop', async () => {
    const res = await request(app)
      .post(`/api/trips/${tripId}/log`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ studentId: student2Id, action: 'arrived', lat: -1.2888, lng: 36.7845 });

    expect(res.status).toBe(201);
  });

  test('Step 11: Driver picks up second student', async () => {
    const res = await request(app)
      .post(`/api/trips/${tripId}/log`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ studentId: student2Id, action: 'check_in', lat: -1.2888, lng: 36.7845 });

    expect(res.status).toBe(201);
  });

  test('Step 12: Driver ends the trip', async () => {
    const res = await request(app)
      .put(`/api/trips/${tripId}/end`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.trip.status).toBe('completed');
    expect(res.body.trip.endedAt).toBeDefined();
  });

  // ==================== MESSAGING ====================
  test('Step 13: Parent sends message to driver', async () => {
    const res = await request(app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${parent1Token}`)
      .send({
        receiverId: driverId,
        content: 'Thank you for the safe ride!',
        messageType: 'text',
      });

    expect(res.status).toBe(201);
  });

  test('Step 14: Driver replies to parent', async () => {
    const res = await request(app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        receiverId: parent1Id,
        content: 'You are welcome! See you tomorrow.',
        messageType: 'text',
      });

    expect(res.status).toBe(201);
  });

  test('Step 15: Parent views conversation thread', async () => {
    const res = await request(app)
      .get(`/api/messages/thread/${driverId}`)
      .set('Authorization', `Bearer ${parent1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2);
    // Should contain the two text messages we sent
    const textMessages = res.body.messages.filter(m => m.messageType === 'text');
    expect(textMessages.length).toBe(2);
  });

  // ==================== NOTIFICATIONS ====================
  test('Step 16: Parent can view notifications (trip alerts)', async () => {
    const res = await request(app)
      .get('/api/messages/notifications')
      .set('Authorization', `Bearer ${parent1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
    // Should have trip-related notifications from the trip lifecycle
  });

  test('Step 17: Parent can see their assigned drivers', async () => {
    const res = await request(app)
      .get('/api/messages/my-drivers')
      .set('Authorization', `Bearer ${parent1Token}`);

    expect(res.status).toBe(200);
    expect(res.body.drivers).toBeInstanceOf(Array);
    expect(res.body.drivers.length).toBeGreaterThan(0);
    expect(res.body.drivers[0].firstName).toBe('E2E');
  });

  test('Step 18: Driver can see route parents', async () => {
    const res = await request(app)
      .get(`/api/messages/route-parents/${routeId}`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.parents.length).toBe(2);
  });

  // ==================== VERIFICATION ====================
  test('Step 19: Trip logs are complete', async () => {
    const res = await request(app)
      .get(`/api/trips/${tripId}/logs`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.logs).toBeInstanceOf(Array);
    expect(res.body.logs.length).toBe(4); // arrived+checkin for 2 students
  });

  test('Step 20: Admin can view completed trip summary', async () => {
    const res = await request(app)
      .get('/api/trips')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const completedTrip = res.body.trips.find(t => t.id === tripId);
    expect(completedTrip).toBeDefined();
    expect(completedTrip.status).toBe('completed');
  });
});
