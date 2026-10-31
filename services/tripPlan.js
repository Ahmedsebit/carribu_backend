const { distanceInMeters } = require('./geo');
const TERMINAL_STATES = new Set(['dropped_off', 'absent']);
const PICKUP_STATES = new Set(['pending', 'arrived_pickup']);
const ONBOARD_STATES = new Set(['on_bus', 'arrived_dropoff']);
const GPS_FRESHNESS_MS = 2 * 60 * 1000;

function coordinate(value, limit) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

function point(lat, lng, address) {
  return { lat: coordinate(lat, 90), lng: coordinate(lng, 180), address: address || null };
}

function validPoint(value) {
  return value?.lat != null && value?.lng != null;
}

function buildTripPlan(trip, route, waypoints = [], { legacy = false } = {}) {
  const outbound = waypoints.filter(w => w.leg === 'outbound')
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const last = outbound[outbound.length - 1];
  const school = point(last?.lat, last?.lng, last?.label || 'School');
  const direction = trip.type === 'afternoon_dropoff' ? -1 : 1;
  const students = [...(route.students || [])].sort((a, b) =>
    direction * ((a.RouteStudent?.stopOrder || 0) - (b.RouteStudent?.stopOrder || 0)));
  return {
    version: 1,
    schoolId: route.schoolId,
    routeName: route.name,
    legacyAutoBoarded: legacy && trip.type === 'afternoon_dropoff',
    school,
    stops: students.map((student, index) => {
      const parent = student.parent;
      const home = point(parent?.pickupLat, parent?.pickupLng, parent?.pickupAddress);
      const dropoff = validPoint(point(parent?.dropoffLat, parent?.dropoffLng))
        ? point(parent.dropoffLat, parent.dropoffLng, parent.dropoffAddress)
        : home;
      return {
        stopNumber: index + 1,
        studentId: student.id,
        studentName: `${student.firstName} ${student.lastName}`,
        admissionNumber: student.admissionNumber,
        firstName: student.firstName,
        lastName: student.lastName,
        grade: student.grade,
        parentId: parent?.id || null,
        parentName: parent ? `${parent.firstName} ${parent.lastName}` : null,
        parentPhone: parent?.phone || null,
        pickup: trip.type === 'afternoon_dropoff' ? school : home,
        dropoff: trip.type === 'afternoon_dropoff' ? dropoff : school,
      };
    }),
  };
}

function validateTripPlan(plan) {
  if (!plan.stops.length) return 'Assign at least one student to this route.';
  if (!validPoint(plan.school)) return 'Set a valid final outbound route waypoint for the school destination.';
  const invalid = plan.stops.find(s => !s.parentId || !validPoint(s.pickup) || !validPoint(s.dropoff));
  return invalid ? `Set valid pickup/drop-off coordinates and a parent for ${invalid.studentName}.` : null;
}

function studentState(stop, logs, legacyAutoBoarded = false) {
  let status = legacyAutoBoarded ? 'on_bus' : 'pending';
  let arrivedAt = null, pickedAt = null, droppedAt = null, dropoffArrivedAt = null;
  const ordered = logs.filter(log => log.studentId === stop.studentId)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp) || a.id - b.id);
  for (const log of ordered) {
    if (log.action === 'check_in') { status = 'on_bus'; pickedAt ||= log.timestamp; }
    if (log.action === 'check_out') { status = 'dropped_off'; droppedAt ||= log.timestamp; }
    if (log.action === 'absent') status = 'absent';
    if (log.action === 'arrived' && !TERMINAL_STATES.has(status)) {
      const phase = log.phase || (ONBOARD_STATES.has(status) ? 'dropoff' : 'pickup');
      status = phase === 'dropoff' ? 'arrived_dropoff' : 'arrived_pickup';
      if (phase === 'dropoff') dropoffArrivedAt ||= log.timestamp;
      else arrivedAt ||= log.timestamp;
    }
  }
  const waitSeconds = arrivedAt && pickedAt
    ? Math.max(0, Math.round((new Date(pickedAt) - new Date(arrivedAt)) / 1000)) : null;
  return {
    ...stop, status, arrivedAt, pickedAt, droppedAt, dropoffArrivedAt, waitSeconds,
    pickupAddress: stop.pickup.address, pickupLat: stop.pickup.lat, pickupLng: stop.pickup.lng,
    dropoffAddress: stop.dropoff.address, dropoffLat: stop.dropoff.lat, dropoffLng: stop.dropoff.lng,
  };
}

function getTripState(trip, logs = trip.logs || []) {
  const plan = trip.plan || buildTripPlan(trip, trip.route || {}, trip.route?.routeWaypoints || [], {
    legacy: trip.status === 'completed' && !!trip.startedAt,
  });
  const pickupList = plan.stops.map(stop => studentState(stop, logs, plan.legacyAutoBoarded));
  const waiting = pickupList.filter(s => PICKUP_STATES.has(s.status));
  const onboard = pickupList.filter(s => ONBOARD_STATES.has(s.status));
  const operationalPhase = waiting.length
    ? (trip.type === 'afternoon_dropoff' ? 'boarding' : 'pickup')
    : onboard.length ? (trip.type === 'afternoon_dropoff' ? 'dropoff' : 'school_dropoff') : 'complete';
  const queue = waiting.length ? waiting : onboard;
  const stopDTO = student => {
    if (!student) return null;
    const actionPhase = PICKUP_STATES.has(student.status) ? 'pickup' : 'dropoff';
    const destination = student[actionPhase];
    return { ...student, ...destination, phase: actionPhase, tripPhase: operationalPhase };
  };
  return {
    phase: trip.status === 'completed' ? 'completed' : operationalPhase,
    currentStop: stopDTO(queue[0]),
    nextStop: stopDTO(queue[1]),
    pickupList,
    canEnd: pickupList.length > 0 && pickupList.every(s => TERMINAL_STATES.has(s.status)),
    stats: {
      total: pickupList.length,
      pending: waiting.length,
      arrived: pickupList.filter(s => s.status.startsWith('arrived_')).length,
      onBus: onboard.length,
      droppedOff: pickupList.filter(s => s.status === 'dropped_off').length,
      absent: pickupList.filter(s => s.status === 'absent').length,
    },
  };
}

function actionPhase(action, status, requestedPhase) {
  if (!['arrived', 'check_in', 'check_out', 'absent'].includes(action)) {
    throw Object.assign(new Error('Invalid student action.'), { status: 400 });
  }
  if (requestedPhase != null && !['pickup', 'dropoff'].includes(requestedPhase)) {
    throw Object.assign(new Error('Phase must be pickup or dropoff.'), { status: 400 });
  }
  const phase = action === 'check_out' ? 'dropoff'
    : action === 'arrived' ? requestedPhase || (ONBOARD_STATES.has(status) ? 'dropoff' : 'pickup')
      : 'pickup';
  if (requestedPhase && requestedPhase !== phase) {
    throw Object.assign(new Error('The phase does not match this action.'), { status: 400 });
  }
  return phase;
}

function assertTransition(action, phase, status) {
  const permitted = action === 'check_out' || (action === 'arrived' && phase === 'dropoff')
    ? ONBOARD_STATES.has(status) : PICKUP_STATES.has(status);
  if (!permitted) throw Object.assign(
    new Error(`Cannot record ${action} (${phase}) while the student is ${status}.`), { status: 409 });
}

function locationFreshness(recordedAt, now = Date.now()) {
  const time = recordedAt == null || recordedAt === '' ? NaN : new Date(recordedAt).getTime();
  const age = now - time;
  const ageSeconds = Number.isFinite(time) ? Math.floor((now - time) / 1000) : null;
  return {
    ageSeconds,
    isFresh: Number.isFinite(age) && age >= -30000 && age <= GPS_FRESHNESS_MS,
  };
}

function estimateStopETA(state, studentId, location, now = Date.now()) {
  if (state.phase === 'boarding' || !location || !locationFreshness(location.recordedAt, now).isFresh) return null;
  const queue = state.pickupList.filter(s =>
    ['pickup', 'boarding'].includes(state.phase) ? PICKUP_STATES.has(s.status) : ONBOARD_STATES.has(s.status));
  const index = queue.findIndex(s => s.studentId === studentId);
  if (index < 0) return null;
  const phase = ['pickup', 'boarding'].includes(state.phase) ? 'pickup' : 'dropoff';
  const destination = queue[index][phase];
  if (!validPoint(destination)) return null;
  const lat = coordinate(location.lat, 90), lng = coordinate(location.lng, 180);
  if (lat == null || lng == null) return null;
  const distanceMeters = distanceInMeters(lat, lng, destination.lat, destination.lng);
  const speed = Number(location.speed) > 0 ? Math.min(Number(location.speed), 100) : 30;
  const travelMinutes = distanceMeters / 1000 / speed * 60;
  return {
    distanceMeters: Math.round(distanceMeters), distanceKm: Math.round(distanceMeters / 100) / 10,
    travelMinutes: Math.round(travelMinutes), stopsBefore: index, bufferMinutes: index * 3,
    totalMinutes: Math.max(1, Math.round(travelMinutes + index * 3)),
    phase, approximate: true,
  };
}

module.exports = {
  buildTripPlan, validateTripPlan, getTripState, actionPhase, assertTransition,
  locationFreshness, estimateStopETA, PICKUP_STATES, ONBOARD_STATES,
};
