const { sequelize, BusLocation, Trip, Vehicle, VehicleTrackerPosition, Route, TripLog } = require('../models');
const { notifyTrip } = require('../socket');
const { distanceInMeters } = require('./geo');
const { getTripState, locationFreshness, estimateStopETA } = require('./tripPlan');
const { ensureTripPlan } = require('./tripWorkflow');
const { enqueueNotification } = require('./notificationOutbox');

const getLocationSource = vehicle => vehicle.trackerUniqueId?.trim() ? 'traccar' : 'phone';

async function getTripLocationWhere(trip) {
  const where = { tripId: trip.id };
  if (trip.status === 'in_progress') {
    const vehicle = trip.vehicle || await Vehicle.findByPk(trip.vehicleId);
    if (!vehicle) throw Object.assign(new Error('Trip vehicle not found.'), { status: 404 });
    where.source = getLocationSource(vehicle);
  }
  return where;
}

async function getAdminTripLocation(trip) {
  const isActive = trip.status === 'in_progress';
  const vehicle = isActive ? trip.vehicle || await Vehicle.findByPk(trip.vehicleId) : null;
  if (isActive && !vehicle) {
    throw Object.assign(new Error('Trip vehicle not found.'), { status: 404 });
  }
  const where = await getTripLocationWhere({
    id: trip.id, status: trip.status, vehicleId: trip.vehicleId, vehicle,
  });
  if (isActive) where.vehicleId = vehicle.id;
  let location = await BusLocation.findOne({
    where,
    attributes: ['lat', 'lng', 'speed', 'heading', 'recordedAt', 'source'],
    order: [['recorded_at', 'DESC']],
  });
  let isLastKnown = false;
  if (!location && isActive && getLocationSource(vehicle) === 'traccar') {
    location = await VehicleTrackerPosition.findOne({
      where: { vehicleId: vehicle.id, trackerUniqueId: vehicle.trackerUniqueId },
    });
    isLastKnown = Boolean(location);
  }
  return location ? {
    lat: parseFloat(location.lat),
    lng: parseFloat(location.lng),
    speed: location.speed == null ? null : parseFloat(location.speed),
    heading: location.heading == null ? null : parseFloat(location.heading),
    recordedAt: location.recordedAt,
    source: isLastKnown ? 'traccar' : location.source,
    isLastKnown,
    ...locationFreshness(location.recordedAt),
    predatesTrip: Boolean(isLastKnown && trip.startedAt
      && new Date(location.recordedAt) < new Date(trip.startedAt)),
  } : null;
}

async function recordDriverLocation({ tripId, lat, lng, speed, heading } = {}, user) {
  if (!['driver', 'coordinator', 'school_admin'].includes(user.role)) {
    throw Object.assign(new Error('Only the assigned driver can update a trip location.'), { status: 403 });
  }
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!tripId || lat == null || lng == null || lat === '' || lng === ''
    || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw Object.assign(new Error('A tripId and valid lat/lng coordinates are required.'), { status: 400 });
  }
  const trip = await Trip.findOne({
    where: { id: tripId, driverId: user.id, status: 'in_progress' },
    include: [
      { model: Vehicle, as: 'vehicle', attributes: ['id', 'trackerUniqueId'] },
      { model: Route, as: 'route', where: { schoolId: user.schoolId }, attributes: ['schoolId'], required: true },
    ],
  });
  if (!trip || !trip.vehicle) {
    throw Object.assign(new Error('Active trip not found.'), { status: 404 });
  }
  if (getLocationSource(trip.vehicle) === 'traccar') {
    throw Object.assign(new Error('This trip uses its linked Traccar device. Phone GPS sharing must stop.'), {
      status: 409, code: 'TRACCAR_LOCATION_REQUIRED',
    });
  }
  return recordLocation({
    trip, schoolId: user.schoolId, driverId: user.id,
    lat: latitude, lng: longitude,
    speed: speed == null ? null : Number(speed),
    heading: heading == null ? null : Number(heading),
    source: 'phone',
  });
}

async function recordLocation({
  trip,
  schoolId,
  driverId,
  lat,
  lng,
  speed,
  heading,
  recordedAt = new Date(),
  trackerPositionId = null,
  trackerUniqueId = null,
  source = 'phone',
}) {
  return sequelize.transaction(async transaction => {
  trip = await Trip.findByPk(trip.id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!trip || trip.status !== 'in_progress') {
    throw Object.assign(new Error('Active trip not found.'), { status: 404 });
  }
  recordedAt = new Date(recordedAt);
  if (!Number.isFinite(recordedAt.getTime()) || recordedAt.getTime() > Date.now() + 30000
    || (trip.startedAt && recordedAt < new Date(trip.startedAt))) {
    throw Object.assign(new Error('A GPS fix must have a valid timestamp during this trip.'), { status: 400 });
  }
  const vehicle = await Vehicle.findByPk(trip.vehicleId, { transaction, lock: transaction.LOCK.UPDATE });
  if (!vehicle || getLocationSource(vehicle) !== source
    || (source === 'traccar' && trackerUniqueId !== vehicle.trackerUniqueId)) {
    throw Object.assign(new Error('The active trip location source changed.'), { status: 409, code: 'TRACCAR_LOCATION_REQUIRED' });
  }
  await ensureTripPlan(trip, transaction);
  if (trip.plan.schoolId !== schoolId) throw Object.assign(new Error('Trip not found.'), { status: 404 });
  const latest = await BusLocation.findOne({
    where: { tripId: trip.id, source }, order: [['recorded_at', 'DESC']], transaction,
  });
  const values = {
    tripId: trip.id,
    vehicleId: trip.vehicleId,
    driverId: driverId || trip.driverId || null,
    lat,
    lng,
    speed,
    heading,
    recordedAt,
    trackerPositionId,
    source,
  };
  let location;
  let created = true;
  if (trackerPositionId != null) {
    [location, created] = await BusLocation.findOrCreate({
      where: { trackerPositionId },
      defaults: values, transaction,
    });
  } else {
    location = await BusLocation.create(values, { transaction });
  }
  if (!created) return { location, created };

  if (latest && new Date(recordedAt) < new Date(latest.recordedAt)) return { location, created };
  transaction.afterCommit(() => notifyTrip(trip.id, 'location-update', {
    tripId: trip.id, driverId: values.driverId, lat, lng, speed, heading,
    timestamp: recordedAt.getTime(), recordedAt, source, ...locationFreshness(recordedAt),
  }));
  if (!locationFreshness(recordedAt).isFresh) return { location, created };
  const logs = await TripLog.findAll({ where: { tripId: trip.id }, transaction });
  const state = getTripState(trip, logs);
  if (state.phase === 'boarding') return { location, created };
  for (const student of state.pickupList) {
    const eta = estimateStopETA(state, student.studentId, values);
    if (!eta) continue;
    const near = state.currentStop?.studentId === student.studentId && eta.distanceMeters <= 200;
    if (!near && eta.totalMinutes > 5) continue;
    const message = near
      ? `The bus is within 200 metres of ${student.studentName}'s ${eta.phase === 'pickup' ? 'pickup' : 'drop-off'} stop.`
      : `The bus is approximately ${eta.totalMinutes} minutes from ${student.studentName}'s ${eta.phase === 'pickup' ? 'pickup' : 'drop-off'} stop.`;
    await enqueueNotification({
      trip, student, event: 'driver-approaching', key: `${near ? 'near' : 'eta'}:${eta.phase}`,
      message, extra: { phase: eta.phase, etaMinutes: eta.totalMinutes, recordedAt },
    }, transaction);
  }
  return { location, created };
  });
}

module.exports = { distanceInMeters, recordLocation, recordDriverLocation, getLocationSource, getTripLocationWhere, getAdminTripLocation };
