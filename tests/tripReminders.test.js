/**
 * Trip acknowledgement / delayed / missed lifecycle tests.
 *
 * Covers the flow where an admin schedules a timed trip, the backend flags it
 * 'delayed' once its start time passes unacknowledged, the driver can still
 * acknowledge (start) a delayed trip, and a trip whose start window lapses is
 * marked 'missed' and can no longer be acknowledged.
 */
const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, getTestData } = require('./setup');
const { Trip } = require('../models');
const { checkDelayedTrips, checkMissedTrips } = require('../services/tripReminders');

const OFFSET_HOURS = parseFloat(process.env.SCHOOL_UTC_OFFSET_HOURS || '3');

// Build the school-local wall-clock date/time whose scheduled start instant is
// `instantMs`, matching how tripReminders interprets scheduled_date/time.
function wallClock(instantMs) {
  const d = new Date(instantMs + OFFSET_HOURS * 3600 * 1000);
  const iso = d.toISOString();
  return { scheduledDate: iso.split('T')[0], scheduledTime: iso.split('T')[1].slice(0, 5) };
}

let adminToken, driverToken;

beforeAll(async () => {
  await setupTestDB();
  const [adminRes, driverRes] = await Promise.all([
    request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'admin123' }),
    request(app).post('/api/auth/login').send({ email: 'driver@test.com', password: 'driver123' }),
  ]);
  adminToken = adminRes.body.token;
  driverToken = driverRes.body.token;
});

async function createTimedTrip(startInstantMs) {
  const { route } = getTestData();
  const { scheduledDate, scheduledTime } = wallClock(startInstantMs);
  const res = await request(app)
    .post('/api/trips')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ routeId: route.id, type: 'morning_pickup', scheduledDate, scheduledTime });
  expect(res.status).toBe(201);
  return res.body.trip.id;
}

describe('Trip acknowledgement lifecycle', () => {
  test('a scheduled trip past its start time is flagged delayed', async () => {
    const id = await createTimedTrip(Date.now() - 5 * 60 * 1000); // 5 min ago
    const flagged = await checkDelayedTrips(Date.now());
    expect(flagged).toContain(id);
    const trip = await Trip.findByPk(id);
    expect(trip.status).toBe('delayed');
  });

  test('driver can acknowledge (start) a delayed trip', async () => {
    const id = await createTimedTrip(Date.now() - 5 * 60 * 1000);
    await checkDelayedTrips(Date.now());
    const res = await request(app)
      .put(`/api/trips/${id}/acknowledge`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(200);
    expect(res.body.trip.status).toBe('in_progress');
    expect(res.body.trip.startedAt).toBeDefined();
  });

  test('a trip whose start window lapses is marked missed', async () => {
    const id = await createTimedTrip(Date.now() - 45 * 60 * 1000); // 45 min ago (> 30m grace)
    const missed = await checkMissedTrips(Date.now());
    expect(missed).toContain(id);
    const trip = await Trip.findByPk(id);
    expect(trip.status).toBe('missed');
  });

  test('a missed trip cannot be acknowledged', async () => {
    const id = await createTimedTrip(Date.now() - 45 * 60 * 1000);
    await checkMissedTrips(Date.now());
    const res = await request(app)
      .put(`/api/trips/${id}/acknowledge`)
      .set('Authorization', `Bearer ${driverToken}`);
    expect(res.status).toBe(400);
  });
});
