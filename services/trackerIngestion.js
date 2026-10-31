const { Vehicle, Trip, TrackerEvent } = require('../models');
const { recordLocation } = require('./locationTracking');
const { rememberTrackerPosition } = require('./trackerPositionSnapshot');

const KNOTS_TO_KMH = 1.852;

function parseDate(value, fallback = new Date()) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function parseOptionalId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = String(value);
  return /^\d+$/.test(id) ? id : null;
}

async function resolveContext(device) {
  const uniqueId = String(device?.uniqueId || '').trim();
  if (!uniqueId) return { ignored: 'missing_device_unique_id' };
  const vehicle = await Vehicle.findOne({ where: { trackerUniqueId: uniqueId, status: 'active' } });
  if (!vehicle) return { ignored: 'unknown_device', uniqueId };
  const trip = await Trip.findOne({
    where: { vehicleId: vehicle.id, status: 'in_progress' },
    order: [['started_at', 'DESC']],
  });
  return { vehicle, trip, uniqueId };
}

async function ingestPosition({ position, device } = {}) {
  const latitude = Number(position?.latitude);
  const longitude = Number(position?.longitude);
  if (!position || !device || position.latitude == null || position.longitude == null
    || position.latitude === '' || position.longitude === ''
    || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return { status: 400, body: { error: 'Valid Traccar position and device payloads are required.' } };
  }
  if (position.valid === false) {
    return { status: 202, body: { accepted: true, ignored: 'invalid_gps_fix' } };
  }

  const context = await resolveContext(device);
  if (context.ignored) {
    console.warn(`Traccar position ignored: ${context.ignored}${context.uniqueId ? ` (${context.uniqueId})` : ''}.`);
    return { status: 202, body: { accepted: true, ignored: context.ignored } };
  }
  if (!context.trip) {
    return { status: 202, body: { accepted: true, ignored: 'no_active_trip' } };
  }

  const speedKnots = Number(position.speed);
  const heading = Number(position.course);
  const recordedAt = parseDate(position.fixTime || position.deviceTime || position.serverTime, null);
  if (!recordedAt) {
    return { status: 202, body: { accepted: true, ignored: 'invalid_position_time' } };
  }
  if (recordedAt.getTime() > Date.now() + 30000) {
    return { status: 202, body: { accepted: true, ignored: 'position_time_in_future' } };
  }
  const values = {
    lat: latitude,
    lng: longitude,
    speed: Number.isFinite(speedKnots) ? speedKnots * KNOTS_TO_KMH : null,
    heading: Number.isFinite(heading) ? heading : null,
    recordedAt,
    trackerPositionId: parseOptionalId(position.id),
  };
  const remembered = await rememberTrackerPosition({
    ...values, vehicleId: context.vehicle.id, trackerUniqueId: context.uniqueId,
  });
  if (!remembered) {
    return { status: 202, body: { accepted: true, ignored: 'tracker_assignment_changed' } };
  }
  if (context.trip.startedAt && recordedAt < new Date(context.trip.startedAt)) {
    return { status: 202, body: { accepted: true, ignored: 'position_before_trip' } };
  }
  const { location, created } = await recordLocation({
    trip: context.trip,
    schoolId: context.vehicle.schoolId,
    driverId: context.trip.driverId,
    ...values,
    source: 'traccar',
    trackerUniqueId: context.uniqueId,
  });

  return {
    status: created ? 201 : 200,
    body: {
      accepted: true,
      duplicate: !created,
      tripId: context.trip.id,
      locationId: location.id,
    },
  };
}

async function ingestEvent({ event, position, device } = {}, io) {
  const eventType = String(event?.type || '').trim();
  if (!event || !device || !eventType || eventType.length > 100) {
    return { status: 400, body: { error: 'Valid Traccar event and device payloads are required.' } };
  }

  const context = await resolveContext(device);
  if (context.ignored) {
    console.warn(`Traccar event ignored: ${context.ignored}${context.uniqueId ? ` (${context.uniqueId})` : ''}.`);
    return { status: 202, body: { accepted: true, ignored: context.ignored } };
  }

  const trackerEventId = parseOptionalId(event.id);
  const values = {
    vehicleId: context.vehicle.id,
    tripId: context.trip?.id || null,
    trackerEventId,
    eventType,
    eventTime: parseDate(event.eventTime || position?.fixTime || position?.deviceTime),
    attributes: {
      event: event.attributes || {},
      position: position?.attributes || {},
      protocol: position?.protocol || null,
      latitude: Number.isFinite(Number(position?.latitude)) ? Number(position.latitude) : null,
      longitude: Number.isFinite(Number(position?.longitude)) ? Number(position.longitude) : null,
    },
  };
  let trackerEvent;
  let created = true;
  if (trackerEventId != null) {
    [trackerEvent, created] = await TrackerEvent.findOrCreate({
      where: { trackerEventId },
      defaults: values,
    });
  } else {
    trackerEvent = await TrackerEvent.create(values);
  }

  if (created) {
    io?.to(`school:${context.vehicle.schoolId}`).emit('tracker-event', {
      id: trackerEvent.id,
      vehicleId: context.vehicle.id,
      tripId: context.trip?.id || null,
      type: eventType,
      eventTime: trackerEvent.eventTime,
      attributes: trackerEvent.attributes,
    });
  }

  return {
    status: created ? 201 : 200,
    body: {
      accepted: true,
      duplicate: !created,
      eventId: trackerEvent.id,
    },
  };
}

module.exports = { ingestPosition, ingestEvent };
