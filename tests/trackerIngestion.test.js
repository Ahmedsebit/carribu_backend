const express = require('express');
const request = require('supertest');

jest.mock('../models', () => ({
  Vehicle: { findOne: jest.fn() },
  Trip: { findOne: jest.fn() },
  TrackerEvent: { findOrCreate: jest.fn(), create: jest.fn() },
}));
jest.mock('../services/locationTracking', () => ({ recordLocation: jest.fn() }));
jest.mock('../services/trackerPositionSnapshot', () => ({ rememberTrackerPosition: jest.fn() }));

const { Vehicle, Trip, TrackerEvent } = require('../models');
const { recordLocation } = require('../services/locationTracking');
const { rememberTrackerPosition } = require('../services/trackerPositionSnapshot');
const { ingestPosition, ingestEvent } = require('../services/trackerIngestion');
const controller = require('../controllers/trackerController');

describe('shared Traccar ingestion', () => {
  const device = { id: 7, uniqueId: 'test-imei' };
  const position = {
    id: 101, latitude: -1.2, longitude: 36.8, speed: 10, course: 90,
    fixTime: '2026-10-23T06:05:00Z', valid: true,
  };
  const vehicle = { id: 1, schoolId: 4 };
  const trip = { id: 2, vehicleId: 1, driverId: 3, startedAt: new Date('2026-10-23T06:00:00Z') };

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    Vehicle.findOne.mockResolvedValue(vehicle);
    Trip.findOne.mockResolvedValue(trip);
    recordLocation.mockResolvedValue({ location: { id: 10 }, created: true });
    rememberTrackerPosition.mockResolvedValue(true);
  });

  afterEach(() => jest.restoreAllMocks());

  test('maps uniqueId and the active trip, converts knots, and preserves deduplication', async () => {
    const first = await ingestPosition({ device, position });
    expect(first).toEqual({ status: 201, body: { accepted: true, duplicate: false, tripId: 2, locationId: 10 } });
    expect(Vehicle.findOne).toHaveBeenCalledWith({ where: { trackerUniqueId: 'test-imei', status: 'active' } });
    expect(Trip.findOne).toHaveBeenCalledWith({
      where: { vehicleId: 1, status: 'in_progress' }, order: [['started_at', 'DESC']],
    });
    expect(recordLocation).toHaveBeenCalledWith({
      trip, schoolId: 4, driverId: 3, lat: -1.2, lng: 36.8, speed: 18.52,
      heading: 90, recordedAt: new Date(position.fixTime), trackerPositionId: '101', source: 'traccar', trackerUniqueId: 'test-imei',
    });
    recordLocation.mockResolvedValue({ location: { id: 10 }, created: false });
    expect((await ingestPosition({ device, position })).body.duplicate).toBe(true);
  });

  test('keeps stale snapshots separate from trip history and ignores invalid, unknown and off-trip updates', async () => {
    const old = await ingestPosition({ device, position: { ...position, fixTime: '2026-10-22T00:00:00Z' } });
    expect(old.body.ignored).toBe('position_before_trip');
    expect(rememberTrackerPosition).toHaveBeenCalledWith(expect.objectContaining({
      trackerUniqueId: 'test-imei', vehicleId: 1, recordedAt: new Date('2026-10-22T00:00:00Z'),
    }));
    rememberTrackerPosition.mockClear();
    expect((await ingestPosition({ device, position: { ...position, valid: false } })).body.ignored).toBe('invalid_gps_fix');
    Vehicle.findOne.mockResolvedValueOnce(null);
    expect((await ingestPosition({ device, position })).body.ignored).toBe('unknown_device');
    Trip.findOne.mockResolvedValueOnce(null);
    expect((await ingestPosition({ device, position })).body.ignored).toBe('no_active_trip');
    expect(recordLocation).not.toHaveBeenCalled();
    expect(rememberTrackerPosition).not.toHaveBeenCalled();
  });

  test.each([undefined, 'not-a-date'])('does not invent a fresh fix time from %p', async fixTime => {
    const result = await ingestPosition({ device, position: { ...position, fixTime } });
    expect(result.body.ignored).toBe('invalid_position_time');
    expect(rememberTrackerPosition).not.toHaveBeenCalled();
    expect(recordLocation).not.toHaveBeenCalled();
  });

  test.each([null, ''])('rejects missing coordinates %p instead of storing a false zero position', async latitude => {
    expect((await ingestPosition({ device, position: { ...position, latitude } })).status).toBe(400);
    expect(rememberTrackerPosition).not.toHaveBeenCalled();
  });

  test('does not ingest a position if the tracker assignment changed while resolving it', async () => {
    rememberTrackerPosition.mockResolvedValue(false);
    const result = await ingestPosition({ device, position });
    expect(result.body.ignored).toBe('tracker_assignment_changed');
    expect(recordLocation).not.toHaveBeenCalled();
  });

  test('surfaces snapshot persistence failures', async () => {
    rememberTrackerPosition.mockRejectedValue(new Error('Snapshot database unavailable.'));
    await expect(ingestPosition({ device, position })).rejects.toThrow('Snapshot database unavailable.');
    expect(recordLocation).not.toHaveBeenCalled();
  });

  test('accepts valid LBS coordinates but never treats an approximate flag as a valid fix', async () => {
    const approximate = {
      ...position,
      speed: 0,
      accuracy: 1500,
      attributes: { approximate: true },
      network: {
        cellTowers: [{
          mobileCountryCode: 234, mobileNetworkCode: 15, locationAreaCode: 1, cellId: 2,
        }],
      },
    };
    const accepted = await ingestPosition({ device, position: approximate });
    expect(accepted.status).toBe(201);
    expect(recordLocation).toHaveBeenCalledWith(expect.objectContaining({
      lat: approximate.latitude, lng: approximate.longitude, speed: 0,
    }));
    recordLocation.mockClear();
    const rejected = await ingestPosition({ device, position: { ...approximate, valid: false } });
    expect(rejected.body.ignored).toBe('invalid_gps_fix');
    expect(recordLocation).not.toHaveBeenCalled();
  });

  test('stores live events without positions and only broadcasts new events to the mapped school', async () => {
    const emit = jest.fn();
    const io = { to: jest.fn(() => ({ emit })) };
    const event = { id: 201, type: 'alarm', eventTime: position.fixTime, attributes: { alarm: 'sos' } };
    const stored = { id: 11, eventTime: new Date(event.eventTime), attributes: { event: event.attributes } };
    TrackerEvent.findOrCreate.mockResolvedValueOnce([stored, true]).mockResolvedValueOnce([stored, false]);
    const first = await ingestEvent({ device, event }, io);
    expect(first.status).toBe(201);
    expect(TrackerEvent.findOrCreate).toHaveBeenCalledWith({
      where: { trackerEventId: '201' },
      defaults: expect.objectContaining({ vehicleId: 1, tripId: 2, eventType: 'alarm' }),
    });
    expect(io.to).toHaveBeenCalledWith('school:4');
    expect(emit).toHaveBeenCalledWith('tracker-event', expect.objectContaining({ id: 11, vehicleId: 1 }));
    expect((await ingestEvent({ device, event }, io)).body.duplicate).toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  test('webhook controllers preserve status, validation, and explicit processing errors', async () => {
    const app = express();
    app.use(express.json());
    app.post('/position', controller.position);
    app.post('/event', controller.event);
    expect((await request(app).post('/position').send({})).status).toBe(400);
    expect((await request(app).post('/event').send({})).status).toBe(400);
    const accepted = await request(app).post('/position').send({ device, position });
    expect(accepted.status).toBe(201);
    expect(accepted.body.locationId).toBe(10);
    recordLocation.mockRejectedValueOnce(new Error('database unavailable'));
    const failed = await request(app).post('/position').send({ device, position });
    expect(failed.status).toBe(500);
    expect(failed.body.error).toBe('Unable to process tracker position.');
    expect(console.error).toHaveBeenCalled();
  });
});
