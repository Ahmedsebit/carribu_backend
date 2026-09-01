/**
 * Messaging & Notifications Tests
 * Tests chat, notifications, and driver-parent communication
 */
const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');
const { Message, Trip } = require('../models');

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

describe('Messaging API', () => {
  test('POST /api/messages - parent can send message to driver', async () => {
    const { driver } = getTestData();
    const res = await request(app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        receiverId: driver.id,
        content: 'Hello driver, my child will be at the stop.',
        messageType: 'text',
      });

    expect(res.status).toBe(201);
    expect(res.body.message.content).toContain('Hello driver');
    expect(res.body.message.messageType).toBe('text');
  });

  test('POST /api/messages - driver can reply to parent', async () => {
    const { parent } = getTestData();
    const res = await request(app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        receiverId: parent.id,
        content: 'Got it, will be there in 10 minutes.',
        messageType: 'text',
      });

    expect(res.status).toBe(201);
    expect(res.body.message.content).toContain('10 minutes');
  });

  test('POST /api/messages - parent can report absence', async () => {
    const { driver } = getTestData();
    const res = await request(app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        receiverId: driver.id,
        content: 'My child will not be coming today - feeling unwell.',
        messageType: 'absence',
      });

    expect(res.status).toBe(201);
    expect(res.body.message.messageType).toBe('absence');
  });

  test('GET /api/messages/conversations - lists conversations', async () => {
    const res = await request(app)
      .get('/api/messages/conversations')
      .set('Authorization', `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.conversations).toBeInstanceOf(Array);
    expect(res.body.conversations.length).toBeGreaterThan(0);
    expect(res.body.conversations[0].partnerName).toBeDefined();
    expect(res.body.conversations[0].lastMessage).toBeDefined();
  });

  test('GET /api/messages/thread/:partnerId - returns message thread', async () => {
    const { driver } = getTestData();
    const res = await request(app)
      .get(`/api/messages/thread/${driver.id}`)
      .set('Authorization', `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toBeInstanceOf(Array);
    expect(res.body.messages.length).toBeGreaterThanOrEqual(2);
  });

  test('GET /api/messages/unread-count - returns unread count', async () => {
    const res = await request(app)
      .get('/api/messages/unread-count')
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(typeof res.body.unreadCount).toBe('number');
  });
});

describe('Notifications API', () => {
  test('POST /api/messages/trip-notification - admin notifies unique parents on selected trips', async () => {
    const { school, route, driver, vehicle } = getTestData();
    const trip = await Trip.create({
      routeId: route.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      type: 'morning_pickup',
      status: 'scheduled',
      scheduledDate: new Date().toISOString().split('T')[0],
    });

    const res = await request(app)
      .post('/api/messages/trip-notification')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        tripIds: [trip.id],
        allTrips: false,
        content: 'The afternoon pickup time has changed.',
      });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(expect.objectContaining({
      recipientCount: 2,
      tripCount: 1,
    }));
    await expect(Message.count({
      where: {
        schoolId: school.id,
        tripId: trip.id,
        content: 'The afternoon pickup time has changed.',
        messageType: 'alert',
      },
    })).resolves.toBe(2);
  });

  test('GET /api/messages/notifications - parent can view notifications', async () => {
    const res = await request(app)
      .get('/api/messages/notifications')
      .set('Authorization', `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.notifications).toBeInstanceOf(Array);
  });

  test('GET /api/messages/my-drivers - parent can see their drivers', async () => {
    const res = await request(app)
      .get('/api/messages/my-drivers')
      .set('Authorization', `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.drivers).toBeInstanceOf(Array);
    expect(res.body.drivers.length).toBeGreaterThan(0);
    expect(res.body.drivers[0].firstName).toBe('Test');
    expect(res.body.drivers[0].lastName).toBe('Driver');
  });

  test('GET /api/messages/route-parents/:routeId - driver can see route parents', async () => {
    const { route } = getTestData();
    const res = await request(app)
      .get(`/api/messages/route-parents/${route.id}`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(res.status).toBe(200);
    expect(res.body.parents).toBeInstanceOf(Array);
    expect(res.body.parents.length).toBeGreaterThan(0);
  });
});

describe('Location API', () => {
  let tripId;

  beforeAll(async () => {
    // Create and start a trip for location testing
    const { route, driver, vehicle } = getTestData();
    const tripRes = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        routeId: route.id, driverId: driver.id, vehicleId: vehicle.id,
        type: 'morning_pickup', scheduledDate: new Date().toISOString().split('T')[0],
      });
    tripId = tripRes.body.trip.id;
    // Start the trip
    await request(app)
      .put(`/api/trips/${tripId}/start`)
      .set('Authorization', `Bearer ${driverToken}`);
  });

  test('POST /api/location/update - driver can update location', async () => {
    const res = await request(app)
      .post('/api/location/update')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        tripId,
        lat: -1.2641,
        lng: 36.8053,
        speed: 45,
        heading: 180,
      });

    expect([200, 201]).toContain(res.status);
  });

  test('POST /api/location/update - parent cannot update location', async () => {
    const res = await request(app)
      .post('/api/location/update')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ tripId, lat: -1.2641, lng: 36.8053 });

    expect(res.status).toBe(403);
  });
});
