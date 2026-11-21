const { Op } = require('sequelize');
const { Trip, Route, Student, User, sequelize } = require('../models');
const { notifyUser, notifyTrip } = require('../socket');
const { buildTripPlan } = require('./tripPlan');

// How many minutes before the scheduled start the driver is reminded.
const LEAD_MINUTES = parseInt(process.env.TRIP_REMINDER_LEAD_MINUTES || '15', 10);
// The scheduled_time/scheduled_date are wall-clock values in the school's local
// time. Since the DB stores no timezone, interpret them at this UTC offset
// (hours). Defaults to +3 (East Africa Time). Override with SCHOOL_UTC_OFFSET_HOURS.
const OFFSET_HOURS = parseFloat(process.env.SCHOOL_UTC_OFFSET_HOURS || '3');
// How many minutes before or after the scheduled time a trip may be started.
const START_WINDOW_MINUTES = parseInt(process.env.TRIP_START_WINDOW_MINUTES || '20', 10);
const POLL_MS = 60 * 1000;

// Absolute UTC millisecond instant for a trip's scheduled start, or null if the
// trip has no explicit time set.
function tripStartMs(trip) {
  if (!trip.scheduledDate || !trip.scheduledTime) return null;
  const [y, mo, d] = String(trip.scheduledDate).split('-').map(Number);
  const [h, mi] = String(trip.scheduledTime).split(':').map(Number);
  if ([y, mo, d, h, mi].some((n) => Number.isNaN(n))) return null;
  return Date.UTC(y, mo - 1, d, h, mi) - OFFSET_HOURS * 3600 * 1000;
}

function schoolDate(now = Date.now()) {
  return new Date(now + OFFSET_HOURS * 3600 * 1000).toISOString().slice(0, 10);
}

// Find scheduled trips whose start is within the reminder window and that have
// not yet been reminded, then notify the assigned driver once each.
async function checkReminders(now = Date.now()) {
  const trips = await Trip.findAll({
    where: {
      status: 'scheduled',
      driverId: { [Op.ne]: null },
      scheduledTime: { [Op.ne]: null },
      reminderSentAt: null,
    },
    include: [{ model: Route, as: 'route', attributes: ['name'] }],
  });

  const sent = [];
  for (const trip of trips) {
    const startMs = tripStartMs(trip);
    if (startMs == null) continue;
    const triggerMs = startMs - LEAD_MINUTES * 60 * 1000;
    // Fire once we enter the lead window, up to the start time (+1 min grace).
    if (now >= triggerMs && now < startMs + 60 * 1000) {
      const minsToStart = Math.max(0, Math.round((startMs - now) / 60000));
      const when = minsToStart <= 0 ? 'now' : `in ${minsToStart} min`;
      const routeName = (trip.route && trip.route.name) || 'your route';
      const kind = trip.type === 'morning_pickup' ? 'morning pickup' : 'afternoon drop-off';
      notifyUser(trip.driverId, 'trip-reminder', {
        message: `Your ${kind} on ${routeName} starts ${when}.`,
        tripId: trip.id,
        routeName,
        scheduledTime: trip.scheduledTime,
      });
      await trip.update({ reminderSentAt: new Date() });
      sent.push(trip.id);
    }
  }
  return sent;
}

// True when a trip has an explicit start time whose window (start + grace) has
// already lapsed at `now`. Legacy untimed trips are restricted to their school date.
function isStartWindowLapsed(trip, now = Date.now()) {
  const startMs = tripStartMs(trip);
  if (startMs == null) return Boolean(trip.scheduledDate && trip.scheduledDate < schoolDate(now));
  return now > startMs + START_WINDOW_MINUTES * 60 * 1000;
}

function isStartWindowEarly(trip, now = Date.now()) {
  const startMs = tripStartMs(trip);
  if (startMs == null) return Boolean(trip.scheduledDate && trip.scheduledDate > schoolDate(now));
  return now < startMs - START_WINDOW_MINUTES * 60 * 1000;
}

const disruptionRoute = {
  model: Route, as: 'route', attributes: ['id', 'name', 'schoolId'],
  include: [{
    model: Student, as: 'students', required: false,
    include: [{ model: User, as: 'parent', attributes: ['id', 'firstName', 'lastName', 'pickupAddress', 'pickupLat', 'pickupLng', 'dropoffAddress', 'dropoffLat', 'dropoffLng'] }],
  }],
};

async function markDisruption(candidate, status, now) {
  return sequelize.transaction(async transaction => {
    // Load lazily because tripWorkflow also imports the start-window helpers.
    if (candidate.route?.schoolId) await require('./tripWorkflow').lockSchool(candidate.route.schoolId, transaction);
    const trip = await Trip.findByPk(candidate.id, {
      include: [disruptionRoute], transaction, lock: { level: transaction.LOCK.UPDATE, of: Trip },
    });
    if (!trip || (status === 'delayed' ? trip.status !== 'scheduled' : !['scheduled', 'delayed'].includes(trip.status))) return null;
    const start = tripStartMs(trip);
    if (status === 'delayed' ? start == null || now <= start || isStartWindowLapsed(trip, now) : !isStartWindowLapsed(trip, now)) return null;
    const route = trip.route;
    let plan = trip.plan;
    const planMatchesSchool = !plan || plan.schoolId == null || plan.schoolId === route?.schoolId;
    if (route && planMatchesSchool && trip.scheduledDate === schoolDate(now)) {
      const values = route.toJSON ? route.toJSON() : route;
      plan = buildTripPlan(trip, {
        ...values, students: (values.students || []).filter(student => student.schoolId === route.schoolId),
      });
      if (trip.plan?.school && trip.plan.schoolId === route.schoolId) plan.school = trip.plan.school;
    }
    await trip.update({ status, ...(plan ? { plan } : {}) }, { transaction });
    const lateMinutes = start == null ? null : Math.max(0, Math.round((now - start) / 60000));
    const recent = trip.scheduledDate === schoolDate(now) || start != null && now - start < 86400000;
    if (recent && plan && route && plan.schoolId === route.schoolId) {
      const { enqueueNotification } = require('./notificationOutbox');
      const kind = trip.type === 'morning_pickup' ? 'morning pickup' : 'afternoon drop-off';
      for (const student of plan.stops || []) {
        await enqueueNotification({
          trip, student, event: status === 'delayed' ? 'trip-delayed' : 'trip-missed', key: status,
          message: status === 'delayed'
            ? `The ${kind} for ${student.studentName} on ${route.name} has not started and is ${lateMinutes} min late. Contact the school if you need an update.`
            : `The ${kind} for ${student.studentName} on ${route.name}, scheduled for ${trip.scheduledDate}, was not started within its allowed window. Please contact the school about alternative transport.`,
          extra: { schoolId: route.schoolId, routeName: route.name, scheduledDate: trip.scheduledDate, scheduledTime: trip.scheduledTime, status, lateMinutes },
        }, transaction);
      }
    }
    transaction.afterCommit(() => {
      if (trip.driverId) notifyUser(trip.driverId, status === 'delayed' ? 'trip-delayed' : 'trip-missed', {
        tripId: trip.id, scheduledTime: trip.scheduledTime, lateMinutes,
        message: status === 'delayed'
          ? `Your trip on ${route?.name || 'your route'} is ${lateMinutes} min late. Start it within its allowed window.`
          : `Your trip on ${route?.name || 'your route'} was not started within its allowed window.`,
      });
      notifyTrip(trip.id, 'trip-status', { tripId: trip.id, status });
    });
    return trip;
  });
}

// Mark scheduled trips as 'delayed' once their scheduled start time has passed
// without the driver acknowledging (starting) them, while they are still within
// the start grace window (i.e. not yet 'missed'). This surfaces "running late"
// trips to the admin dashboard and prompts the driver to acknowledge. The
// assigned driver is notified once per trip (the status change makes it idempotent).
// Accepts an optional extra where filter (e.g. scope to a single driver).
async function checkDelayedTrips(now = Date.now(), extraWhere = {}) {
  const trips = await Trip.findAll({
    where: {
      status: 'scheduled',
      scheduledTime: { [Op.ne]: null },
      ...extraWhere,
    },
    include: [{ model: Route, as: 'route', attributes: ['id', 'name', 'schoolId'] }],
  });

  const delayed = [];
  for (const trip of trips) {
    const startMs = tripStartMs(trip);
    if (startMs == null) continue;
    // Past the scheduled start but the start window has not lapsed yet.
    if (now > startMs && !isStartWindowLapsed(trip, now)) {
      if (!await markDisruption(trip, 'delayed', now)) continue;
      delayed.push(trip.id);
    }
  }
  return delayed;
}

// Mark scheduled/delayed trips as 'missed' once their start window has lapsed
// without the driver starting them. Accepts an optional extra where filter (e.g.
// scope to a single driver) so callers can refresh just the trips they care
// about. The assigned driver is notified once per trip.
async function checkMissedTrips(now = Date.now(), extraWhere = {}) {
  const trips = await Trip.findAll({
    where: {
      status: { [Op.in]: ['scheduled', 'delayed'] },
      ...extraWhere,
    },
    include: [{ model: Route, as: 'route', attributes: ['id', 'name', 'schoolId'] }],
  });

  const missed = [];
  for (const trip of trips) {
    if (!isStartWindowLapsed(trip, now)) continue;
    if (!await markDisruption(trip, 'missed', now)) continue;
    missed.push(trip.id);
  }
  return missed;
}

let timer = null;

function startTripReminderScheduler() {
  if (timer) return;
  timer = setInterval(() => {
    checkReminders().catch((e) => console.warn('Trip reminder check failed:', e.message));
    checkDelayedTrips().catch((e) => console.warn('Delayed trip check failed:', e.message));
    checkMissedTrips().catch((e) => console.warn('Missed trip check failed:', e.message));
  }, POLL_MS);
  if (timer.unref) timer.unref();
  // Kick off shortly after boot so reminders aren't delayed by a full interval.
  setTimeout(() => checkReminders().catch(() => {}), 5000);
  setTimeout(() => checkDelayedTrips().catch(() => {}), 5000);
  setTimeout(() => checkMissedTrips().catch(() => {}), 5000);
  console.log(`⏰ Trip reminder scheduler started (lead ${LEAD_MINUTES}m, start window ±${START_WINDOW_MINUTES}m, offset +${OFFSET_HOURS}h).`);
}

function stopTripReminderScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  startTripReminderScheduler,
  stopTripReminderScheduler,
  checkReminders,
  checkDelayedTrips,
  checkMissedTrips,
  START_WINDOW_MINUTES,
  isStartWindowEarly,
  isStartWindowLapsed,
  tripStartMs,
  schoolDate,
};
