const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');
const { Trip } = require('../models');

const OFFSET_HOURS = parseFloat(process.env.SCHOOL_UTC_OFFSET_HOURS || '3');

function wallClock(instantMs) {
  const date = new Date(instantMs + OFFSET_HOURS * 3600 * 1000);
  const iso = date.toISOString();
  return {
    scheduledDate: iso.slice(0, 10),
    scheduledTime: iso.slice(11, 16),
  };
}

let driverToken;

beforeAll(async () => {
  await setupTestDB();
  const response = await request(app)
    .post('/api/auth/login')
    .send({ email: 'driver@test.com', password: 'driver123' });
  driverToken = response.body.token;
});

afterAll(async () => {
  await teardownTestDB();
});

async function createTrip(startInstantMs) {
  const { route, driver, vehicle } = getTestData();
  const schedule = wallClock(startInstantMs);
  return Trip.create({
    routeId: route.id,
    driverId: driver.id,
    vehicleId: vehicle.id,
    type: 'morning_pickup',
    ...schedule,
  });
}

describe('Trip start window', () => {
  test('rejects a trip more than 20 minutes early', async () => {
    const trip = await createTrip(Date.now() + 22 * 60 * 1000);
    const response = await request(app)
      .put(`/api/trips/${trip.id}/start`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/within 20 minutes/i);
    expect((await trip.reload()).status).toBe('scheduled');
  });

  test('allows a trip within 20 minutes before its scheduled time', async () => {
    const trip = await createTrip(Date.now() + 18 * 60 * 1000);
    const response = await request(app)
      .put(`/api/trips/${trip.id}/start`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(response.status).toBe(200);
    expect(response.body.trip.status).toBe('in_progress');
  });

  test('rejects and marks a trip missed more than 20 minutes late', async () => {
    await Trip.update(
      { status: 'completed', endedAt: new Date() },
      { where: { status: 'in_progress' } }
    );
    const trip = await createTrip(Date.now() - 22 * 60 * 1000);
    const response = await request(app)
      .put(`/api/trips/${trip.id}/start`)
      .set('Authorization', `Bearer ${driverToken}`);

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/missed/i);
    expect((await trip.reload()).status).toBe('missed');
  });
});
