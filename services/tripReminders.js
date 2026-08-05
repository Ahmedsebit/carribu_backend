const { Op } = require('sequelize');
const { Trip, Route } = require('../models');
const { notifyUser, notifyTrip } = require('../socket');

// How many minutes before the scheduled start the driver is reminded.
const LEAD_MINUTES = parseInt(process.env.TRIP_REMINDER_LEAD_MINUTES || '15', 10);
// The scheduled_time/scheduled_date are wall-clock values in the school's local
// time. Since the DB stores no timezone, interpret them at this UTC offset
// (hours). Defaults to +3 (East Africa Time). Override with SCHOOL_UTC_OFFSET_HOURS.
const OFFSET_HOURS = parseFloat(process.env.SCHOOL_UTC_OFFSET_HOURS || '3');
// How long after the scheduled start a driver may still start the trip before
// it is automatically marked 'missed'. Defaults to 30 minutes.
const START_GRACE_MINUTES = parseInt(process.env.TRIP_START_GRACE_MINUTES || '30', 10);
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
// already lapsed at `now`. Trips without a scheduledTime can't be timed out.
function isStartWindowLapsed(trip, now = Date.now()) {
  const startMs = tripStartMs(trip);
  if (startMs == null) return false;
  return now > startMs + START_GRACE_MINUTES * 60 * 1000;
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
    include: [{ model: Route, as: 'route', attributes: ['name'] }],
  });

  const delayed = [];
  for (const trip of trips) {
    const startMs = tripStartMs(trip);
    if (startMs == null) continue;
    // Past the scheduled start but the start window has not lapsed yet.
    if (now > startMs && !isStartWindowLapsed(trip, now)) {
      await trip.update({ status: 'delayed' });
      if (trip.driverId) {
        const routeName = (trip.route && trip.route.name) || 'your route';
        const kind = trip.type === 'morning_pickup' ? 'morning pickup' : 'afternoon drop-off';
        const lateMinutes = Math.max(0, Math.round((now - startMs) / 60000));
        notifyUser(trip.driverId, 'trip-delayed', {
          message: `Your ${kind} on ${routeName} is ${lateMinutes} min past its start time. Acknowledge and start it as soon as possible.`,
          tripId: trip.id,
          routeName,
          scheduledTime: trip.scheduledTime,
          lateMinutes,
        });
      }
      notifyTrip(trip.id, 'trip-status', { tripId: trip.id, status: 'delayed' });
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
      scheduledTime: { [Op.ne]: null },
      ...extraWhere,
    },
    include: [{ model: Route, as: 'route', attributes: ['name'] }],
  });

  const missed = [];
  for (const trip of trips) {
    if (!isStartWindowLapsed(trip, now)) continue;
    await trip.update({ status: 'missed' });
    if (trip.driverId) {
      const routeName = (trip.route && trip.route.name) || 'your route';
      const kind = trip.type === 'morning_pickup' ? 'morning pickup' : 'afternoon drop-off';
      notifyUser(trip.driverId, 'trip-missed', {
        message: `Your ${kind} on ${routeName} was not started in time and has been marked as missed.`,
        tripId: trip.id,
        routeName,
        scheduledTime: trip.scheduledTime,
      });
    }
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
  console.log(`⏰ Trip reminder scheduler started (lead ${LEAD_MINUTES}m, grace ${START_GRACE_MINUTES}m, offset +${OFFSET_HOURS}h).`);
}

function stopTripReminderScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { startTripReminderScheduler, stopTripReminderScheduler, checkReminders, checkDelayedTrips, checkMissedTrips, isStartWindowLapsed, tripStartMs };
