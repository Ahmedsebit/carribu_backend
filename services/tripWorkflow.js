const { Op } = require('sequelize');
const {
  sequelize, Trip, TripLog, Route, RouteWaypoint, Student, User, Vehicle, NotificationOutbox,
} = require('../models');
const { buildTripPlan, validateTripPlan, getTripState, actionPhase, assertTransition } = require('./tripPlan');
const { enqueueNotification } = require('./notificationOutbox');
const { notifyTrip } = require('../socket');
const { isStartWindowEarly, isStartWindowLapsed, START_WINDOW_MINUTES, checkMissedTrips } = require('./tripReminders');

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

async function lockSchool(schoolId, transaction) {
  await sequelize.query('SELECT pg_advisory_xact_lock(:schoolId)', {
    replacements: { schoolId }, transaction,
  });
}

async function loadTrip(id, user, transaction) {
  const trip = await Trip.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!trip) throw fail(404, 'Trip not found.');
  const route = await Route.findOne({
    where: { id: trip.routeId, schoolId: user.schoolId }, transaction,
  });
  if (!route) throw fail(404, 'Trip not found.');
  if (user.role === 'driver' && trip.driverId !== user.id) throw fail(403, 'This trip is assigned to another driver.');
  return { trip, route };
}

async function routeForPlan(routeId, transaction) {
  return Route.findByPk(routeId, {
    include: [
      { model: RouteWaypoint, as: 'routeWaypoints' },
      {
        model: Student, as: 'students', through: { attributes: ['stopOrder'] },
        include: [{
          model: User, as: 'parent',
          attributes: ['id', 'firstName', 'lastName', 'phone', 'pickupAddress', 'pickupLat', 'pickupLng', 'dropoffAddress', 'dropoffLat', 'dropoffLng'],
        }],
      },
    ],
    transaction,
  });
}

async function ensureTripPlan(trip, transaction, starting = false) {
  if (trip.plan) return trip.plan;
  const route = await routeForPlan(trip.routeId, transaction);
  if (!route) throw fail(404, 'Route not found.');
  const plan = buildTripPlan(trip, route, route.routeWaypoints, { legacy: trip.status === 'completed' && !!trip.startedAt });
  if (starting) {
    const invalid = validateTripPlan(plan);
    if (invalid) throw fail(422, invalid);
    if (route.students.some(student => student.isActive === false || student.schoolId !== route.schoolId)) {
      throw fail(409, 'Every rostered student must be active and belong to this school.');
    }
  }
  await trip.update({ plan }, { transaction });
  return plan;
}

async function withTrip(id, user, operation) {
  try {
    return await sequelize.transaction(async transaction => {
      await lockSchool(user.schoolId, transaction);
      const { trip, route } = await loadTrip(id, user, transaction);
      return operation(trip, route, transaction);
    });
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw fail(409, 'This driver or vehicle already has an active trip. Refresh and try again.');
    }
    throw error;
  }
}

async function startTrip(id, user) {
  return withTrip(id, user, async (trip, route, transaction) => {
    if (trip.status === 'in_progress') return { trip, duplicate: true, ...getTripState(trip, await TripLog.findAll({ where: { tripId: trip.id }, transaction })) };
    if (trip.status === 'missed') throw fail(400, 'This trip missed its allowed start window.');
    if (!['scheduled', 'delayed'].includes(trip.status)) throw fail(409, 'This trip cannot be started.');
    if (isStartWindowEarly(trip)) {
      throw fail(400, `Start this trip within ${START_WINDOW_MINUTES} minutes before or after its scheduled time.`);
    }
    if (isStartWindowLapsed(trip)) throw fail(400, 'This trip missed its allowed start window.', { code: 'TRIP_START_WINDOW_LAPSED' });
    if (!route.isActive) throw fail(409, 'This route is inactive.');
    const driver = await User.findOne({
      where: { id: trip.driverId, schoolId: user.schoolId, isActive: true, role: 'driver' }, transaction,
    });
    const vehicle = await Vehicle.findOne({
      where: { id: trip.vehicleId, schoolId: user.schoolId, status: 'active' }, transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!driver || !vehicle) throw fail(409, 'Assign an active driver and an available vehicle before starting.');
    const plan = await ensureTripPlan(trip, transaction, true);
    if (plan.stops.length > vehicle.capacity) throw fail(409, 'The student roster exceeds vehicle capacity.');
    const studentIds = new Set(plan.stops.map(s => s.studentId));
    const candidates = await Trip.findAll({
      where: {
        id: { [Op.ne]: trip.id },
        [Op.or]: [
          { status: 'in_progress' },
          { status: 'completed', type: trip.type, scheduledDate: trip.scheduledDate },
        ],
      },
      include: [{ model: Route, as: 'route', where: { schoolId: user.schoolId }, required: true }],
      transaction,
    });
    for (const other of candidates) {
      const otherPlan = await ensureTripPlan(other, transaction);
      const overlaps = otherPlan.stops.filter(s => studentIds.has(s.studentId));
      if (overlaps.length) throw fail(409, 'Students are already assigned to an active trip or completed this journey today.', {
        conflicts: overlaps.map(s => ({ studentId: s.studentId, conflictingTripId: other.id, activeTripId: other.status === 'in_progress' ? other.id : null })),
      });
      if (other.status === 'in_progress' && (other.driverId === trip.driverId || other.vehicleId === trip.vehicleId)) {
        throw fail(409, 'The driver or vehicle already has an active trip.', { conflictingTripId: other.id });
      }
    }
    await trip.update({ status: 'in_progress', startedAt: new Date() }, { transaction });
    for (const student of plan.stops) {
      const kind = trip.type === 'afternoon_dropoff' ? 'afternoon school boarding' : 'morning pickup';
      await enqueueNotification({
        trip, student, event: 'trip-started', key: 'started',
        message: `The ${kind} trip has started for ${student.studentName}. Track the bus in the app.`,
        extra: { routeName: plan.routeName, driverName: `${driver.firstName} ${driver.lastName}` },
      }, transaction);
    }
    transaction.afterCommit(() => notifyTrip(trip.id, 'trip-status', { tripId: trip.id, status: trip.status }));
    return { trip, duplicate: false, ...getTripState(trip, []) };
  }).catch(async error => {
    if (error.code === 'TRIP_START_WINDOW_LAPSED') await checkMissedTrips(Date.now(), { id });
    throw error;
  });
}

async function logStudentAction(id, user, input) {
  const studentId = Number(input.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) throw fail(400, 'A valid studentId is required.');
  if (input.idempotencyKey != null && (typeof input.idempotencyKey !== 'string'
    || !input.idempotencyKey.trim() || input.idempotencyKey.length > 100)) throw fail(400, 'Invalid idempotency key.');
  if (input.notes != null && typeof input.notes !== 'string') throw fail(400, 'Notes must be text.');
  for (const [field, limit] of [['lat', 90], ['lng', 180]]) {
    if (input[field] != null && (input[field] === '' || !Number.isFinite(Number(input[field])) || Math.abs(Number(input[field])) > limit)) {
      throw fail(400, `Invalid ${field}.`);
    }
  }
  return withTrip(id, user, async (trip, route, transaction) => {
    await ensureTripPlan(trip, transaction);
    const logs = await TripLog.findAll({ where: { tripId: trip.id }, order: [['timestamp', 'ASC'], ['id', 'ASC']], transaction });
    const state = getTripState(trip, logs);
    const student = state.pickupList.find(s => s.studentId === studentId);
    if (!student) throw fail(404, 'Student is not in this trip roster.');
    const keyed = input.idempotencyKey && logs.find(log => log.idempotencyKey === input.idempotencyKey);
    if (keyed) {
      if (keyed.studentId !== studentId || keyed.action !== input.action || (input.phase && keyed.phase !== input.phase)) {
        throw fail(409, 'This idempotency key was already used for a different action.');
      }
      return { log: keyed, duplicate: true, ...state };
    }
    const phase = actionPhase(input.action, student.status, input.phase);
    const previous = logs.find((log, index) => {
      if (log.studentId !== studentId || log.action !== input.action) return false;
      const legacyDropoff = log.action === 'check_out' || (log.action === 'arrived'
        && (trip.plan.legacyAutoBoarded || logs.slice(0, index).some(earlier =>
          earlier.studentId === studentId && earlier.action === 'check_in')));
      return (log.phase || (legacyDropoff ? 'dropoff' : 'pickup')) === phase;
    });
    if (previous) return { log: previous, duplicate: true, ...state };
    if (trip.status !== 'in_progress') throw fail(409, 'Student actions are allowed only during an active trip.');
    assertTransition(input.action, phase, student.status);
    if (phase === 'dropoff' && state.pickupList.some(s => ['pending', 'arrived_pickup'].includes(s.status))) {
      throw fail(409, 'Resolve all pickups or school boarding before starting drop-offs.');
    }
    const log = await TripLog.create({
      tripId: trip.id, studentId, action: input.action, phase,
      idempotencyKey: input.idempotencyKey || null,
      lat: input.lat ?? null, lng: input.lng ?? null, notes: input.notes || null, timestamp: new Date(),
    }, { transaction });
    const event = input.action === 'check_in' ? 'student-picked-up'
      : input.action === 'check_out' ? 'student-dropped-off'
        : input.action === 'arrived' ? 'driver-arrived' : 'school-notification';
    const message = input.action === 'check_in' ? `${student.studentName} has boarded the bus.`
      : input.action === 'check_out' ? `${student.studentName} has been dropped off at ${student.dropoff.address || 'the destination'}.`
        : input.action === 'absent' ? `${student.studentName} was marked absent for this trip.`
          : `The bus has arrived at ${phase === 'pickup' ? student.pickup.address || 'the pickup stop' : student.dropoff.address || 'the drop-off stop'} for ${student.studentName}.`;
    await enqueueNotification({ trip, student, event, key: `${input.action}:${phase}`, message, extra: { phase } }, transaction);
    const updated = getTripState(trip, [...logs, log]);
    transaction.afterCommit(() => {
      notifyTrip(trip.id, 'trip-log', { tripId: trip.id, studentId, action: input.action, phase, timestamp: log.timestamp });
      notifyTrip(trip.id, 'trip-plan', { tripId: trip.id, phase: updated.phase });
    });
    return { log, duplicate: false, ...updated };
  });
}

async function completeTrip(id, user) {
  return withTrip(id, user, async (trip, route, transaction) => {
    await ensureTripPlan(trip, transaction);
    const state = getTripState(trip, await TripLog.findAll({ where: { tripId: trip.id }, transaction }));
    if (trip.status === 'completed') return { trip, duplicate: true, ...state };
    if (trip.status !== 'in_progress') throw fail(409, 'Trip not in progress.');
    if (!state.canEnd) throw fail(409, 'Resolve every student as dropped off or absent before ending this trip.', {
      unresolvedStudents: state.pickupList.filter(s => !['dropped_off', 'absent'].includes(s.status))
        .map(s => ({ studentId: s.studentId, studentName: s.studentName, status: s.status })),
    });
    await trip.update({ status: 'completed', endedAt: new Date() }, { transaction });
    for (const student of trip.plan.stops) {
      await enqueueNotification({
        trip, student, event: 'trip-completed', key: 'completed',
        message: `The trip for ${student.studentName} has completed. All rostered students have a recorded outcome.`,
      }, transaction);
    }
    transaction.afterCommit(() => notifyTrip(trip.id, 'trip-status', { tripId: trip.id, status: 'completed' }));
    return { trip, duplicate: false, ...getTripState(trip, await TripLog.findAll({ where: { tripId: trip.id }, transaction })) };
  });
}

async function notificationDiagnostics(id, user) {
  const trip = await Trip.findByPk(id, { include: [{ model: Route, as: 'route', where: { schoolId: user.schoolId } }] });
  if (!trip) throw fail(404, 'Trip not found.');
  const events = await NotificationOutbox.findAll({
    where: { tripId: trip.id, schoolId: user.schoolId },
    attributes: ['id', 'event', 'status', 'attempts', 'nextAttemptAt', 'lastError', 'providerResults', 'createdAt', 'updatedAt'],
    order: [['id', 'DESC']], limit: 200,
  });
  return { events };
}

module.exports = { startTrip, logStudentAction, completeTrip, notificationDiagnostics, ensureTripPlan, lockSchool };
