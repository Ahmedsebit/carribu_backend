/**
 * Parent Upcoming Trips Tests
 * Verifies GET /api/parent/upcoming-trips only returns the parent's own
 * children's scheduled/delayed trips within the requested date window.
 */
const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');
const { Trip } = require('../models');

let adminToken, parentToken, parent2Token;

const dateOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

beforeAll(async () => {
  await setupTestDB();

  const [adminRes, parentRes, parent2Res] = await Promise.all([
    request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'admin123' }),
    request(app).post('/api/auth/login').send({ email: 'parent@test.com', password: 'parent123' }),
    request(app).post('/api/auth/login').send({ email: 'parent2@test.com', password: 'parent123' }),
  ]);

  adminToken = adminRes.body.token;
  parentToken = parentRes.body.token;
  parent2Token = parent2Res.body.token;

  const { route, driver, vehicle } = getTestData();

  // Tomorrow's scheduled trip - should appear for both parents (shared route)
  await request(app)
    .post('/api/trips')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      routeId: route.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      type: 'morning_pickup',
      scheduledDate: dateOffset(1),
      scheduledTime: '07:30',
    });

  // A trip 10 days out - outside the default 7-day window
  await request(app)
    .post('/api/trips')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      routeId: route.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      type: 'afternoon_dropoff',
      scheduledDate: dateOffset(10),
      scheduledTime: '14:00',
    });

  // A completed trip today - should never show as "upcoming"
  const todayTrip = await request(app)
    .post('/api/trips')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      routeId: route.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      type: 'morning_pickup',
      scheduledDate: dateOffset(0),
    });
  await Trip.update({ status: 'completed' }, { where: { id: todayTrip.body.trip.id } });
});

afterAll(async () => {
  await teardownTestDB();
});

describe('GET /api/parent/upcoming-trips', () => {
  test('parent sees only scheduled trips within the default (tomorrow) window', async () => {
    const res = await request(app)
      .get('/api/parent/upcoming-trips')
      .set('Authorization', `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.trips).toBeInstanceOf(Array);
    expect(res.body.trips).toHaveLength(1);
    expect(res.body.trips[0].scheduledDate).toBe(dateOffset(1));
    expect(res.body.trips[0].status).toBe('scheduled');
  });

  test('widening the window with ?days=14 includes the later trip too', async () => {
    const res = await request(app)
      .get('/api/parent/upcoming-trips')
      .query({ days: 14 })
      .set('Authorization', `Bearer ${parentToken}`);

    expect(res.status).toBe(200);
    expect(res.body.trips).toHaveLength(2);
    const dates = res.body.trips.map((t) => t.scheduledDate);
    expect(dates).toEqual([dateOffset(1), dateOffset(10)]);
  });

  test('each trip only exposes the requesting parent\'s own children', async () => {
    const res = await request(app)
      .get('/api/parent/upcoming-trips')
      .set('Authorization', `Bearer ${parentToken}`);

    const trip = res.body.trips[0];
    expect(trip.children).toHaveLength(1);
    expect(trip.children[0].studentName).toBe('Child One');
  });

  test('the other parent on the same route sees their own child only', async () => {
    const res = await request(app)
      .get('/api/parent/upcoming-trips')
      .set('Authorization', `Bearer ${parent2Token}`);

    expect(res.status).toBe(200);
    expect(res.body.trips).toHaveLength(1);
    expect(res.body.trips[0].children).toHaveLength(1);
    expect(res.body.trips[0].children[0].studentName).toBe('Child Two');
  });

  test('completed trips are never returned as upcoming', async () => {
    const res = await request(app)
      .get('/api/parent/upcoming-trips')
      .query({ days: 14 })
      .set('Authorization', `Bearer ${parentToken}`);

    const statuses = res.body.trips.map((t) => t.status);
    expect(statuses).not.toContain('completed');
  });

  test('non-parent roles are rejected', async () => {
    const res = await request(app)
      .get('/api/parent/upcoming-trips')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
  });
});
