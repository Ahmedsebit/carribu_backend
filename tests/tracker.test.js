const request = require('supertest');
const { app } = require('../server');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');
const { Trip, BusLocation, TrackerEvent } = require('../models');

const TOKEN = 'test-tracker-webhook-token';
const auth = req => req.set('Authorization', `Bearer ${TOKEN}`);

describe('Traccar webhooks', () => {
  let trip;

  beforeAll(async () => {
    process.env.TRACKER_WEBHOOK_TOKEN = TOKEN;
    const { vehicle, route, driver } = await setupTestDB();
    await vehicle.update({ trackerUniqueId: '123456789012345' });
    trip = await Trip.create({
      routeId: route.id,
      vehicleId: vehicle.id,
      driverId: driver.id,
      type: 'morning_pickup',
      scheduledDate: '2026-10-08',
      status: 'in_progress',
      startedAt: new Date('2026-10-08T06:00:00Z'),
    });
  });

  afterAll(async () => {
    delete process.env.TRACKER_WEBHOOK_TOKEN;
    await teardownTestDB();
  });

  test('rejects requests without the shared secret', async () => {
    const response = await request(app).post('/tracker/position').send({});
    expect(response.status).toBe(401);
  });

  test('accepts and deduplicates a mapped active-trip position', async () => {
    const payload = {
      device: { id: 7, uniqueId: '123456789012345', name: 'Test Bus' },
      position: {
        id: 9001,
        protocol: 'gps103',
        valid: true,
        latitude: -1.2641,
        longitude: 36.8053,
        speed: 10,
        course: 90,
        fixTime: '2026-10-08T06:05:00Z',
      },
    };

    const first = await auth(request(app).post('/tracker/position')).send(payload);
    const second = await auth(request(app).post('/tracker/position')).send(payload);

    expect(first.status).toBe(201);
    expect(first.body.tripId).toBe(trip.id);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    const locations = await BusLocation.findAll({ where: { trackerPositionId: '9001' } });
    expect(locations).toHaveLength(1);
    expect(Number(locations[0].speed)).toBeCloseTo(18.52, 2);
  });

  test('acknowledges unknown devices without triggering Traccar retries', async () => {
    const response = await auth(request(app).post('/tracker/position')).send({
      device: { uniqueId: 'unknown-imei' },
      position: { id: 9002, valid: true, latitude: -1.2, longitude: 36.8 },
    });
    expect(response.status).toBe(202);
    expect(response.body.ignored).toBe('unknown_device');
  });

  test('stores and deduplicates tracker events', async () => {
    const payload = {
      device: { uniqueId: '123456789012345' },
      event: {
        id: 8001,
        type: 'alarm',
        eventTime: '2026-10-08T06:06:00Z',
        attributes: { alarm: 'sos' },
      },
      position: {
        protocol: 'gps103',
        latitude: -1.2641,
        longitude: 36.8053,
        attributes: { alarm: 'sos' },
      },
    };

    const first = await auth(request(app).post('/tracker/event')).send(payload);
    const second = await auth(request(app).post('/tracker/event')).send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    const events = await TrackerEvent.findAll({ where: { trackerEventId: '8001' } });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('alarm');
    expect(events[0].tripId).toBe(trip.id);
  });
});
