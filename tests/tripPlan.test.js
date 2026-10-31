const {
  buildTripPlan, validateTripPlan, getTripState, actionPhase, assertTransition,
  locationFreshness, estimateStopETA,
} = require('../services/tripPlan');

const route = {
  id: 1, schoolId: 1, name: 'Route',
  students: [1, 2].map(id => ({
    id, firstName: `Child${id}`, lastName: 'Test', RouteStudent: { stopOrder: id },
    parent: { id: id + 10, firstName: 'Parent', lastName: 'Test', pickupLat: id, pickupLng: 30, dropoffLat: id + 1, dropoffLng: 31 },
  })),
};
const waypoints = [{ leg: 'outbound', orderIndex: 0, lat: 0, lng: 30 }, { leg: 'outbound', orderIndex: 1, lat: 4, lng: 32, label: 'School' }];
const make = type => ({ type, status: 'in_progress', plan: buildTripPlan({ type }, route, waypoints) });
const log = (studentId, action, phase, id = 1) => ({ id, studentId, action, phase, timestamp: new Date(id * 1000) });

test('morning plan preserves zero coordinates and uses the final school waypoint', () => {
  const trip = make('morning_pickup');
  expect(validateTripPlan(trip.plan)).toBeNull();
  expect(trip.plan.stops[0].dropoff).toEqual({ lat: 4, lng: 32, address: 'School' });
  expect(getTripState(trip).currentStop.studentId).toBe(1);
  expect(getTripState(trip).nextStop.studentId).toBe(2);
});

test('new afternoon trips require boarding and use reversed drop-off order', () => {
  const trip = make('afternoon_dropoff');
  const state = getTripState(trip);
  expect(state.phase).toBe('boarding');
  expect(state.pickupList.map(s => s.status)).toEqual(['pending', 'pending']);
  expect(state.currentStop.studentId).toBe(2);
  expect(state.currentStop.lat).toBe(4);
});

test('arrived drop-off retains the on-board count and drop-off transition', () => {
  const trip = make('afternoon_dropoff');
  const state = getTripState(trip, [
    log(1, 'check_in', 'pickup'), log(2, 'absent', 'pickup', 2), log(1, 'arrived', 'dropoff', 3),
  ]);
  expect(state.phase).toBe('dropoff');
  expect(state.currentStop.status).toBe('arrived_dropoff');
  expect(state.stats.onBus).toBe(1);
  expect(() => assertTransition('check_out', 'dropoff', state.currentStop.status)).not.toThrow();
  expect(state.canEnd).toBe(false);
});

test('arrival does not advance navigation until boarding or absence is resolved', () => {
  const trip = make('morning_pickup');
  const state = getTripState(trip, [log(1, 'arrived', 'pickup')]);
  expect(state.currentStop.studentId).toBe(1);
  expect(state.currentStop.status).toBe('arrived_pickup');
});

test('morning boarding transitions to the school, not a parent home', () => {
  const state = getTripState(make('morning_pickup'), [log(1, 'check_in', 'pickup'), log(2, 'absent', 'pickup', 2)]);
  expect(state.phase).toBe('school_dropoff');
  expect(state.currentStop).toMatchObject({ lat: 4, lng: 32, address: 'School', phase: 'dropoff' });
});

test('completion requires a terminal outcome for every student', () => {
  const trip = make('morning_pickup');
  expect(getTripState(trip, [log(1, 'check_in', 'pickup')]).canEnd).toBe(false);
  expect(getTripState(trip, [log(1, 'check_out', 'dropoff'), log(2, 'absent', 'pickup', 2)]).canEnd).toBe(true);
});

test.each([
  ['check_out', 'dropoff', 'pending'], ['check_in', 'pickup', 'dropped_off'],
  ['absent', 'pickup', 'on_bus'], ['arrived', 'pickup', 'on_bus'],
])('rejects invalid %s transition from %s', (action, phase, status) => {
  expect(() => assertTransition(action, phase, status)).toThrow();
});

test('validates actions and explicit phases', () => {
  expect(() => actionPhase('invalid', 'pending')).toThrow();
  expect(() => actionPhase('check_in', 'pending', 'dropoff')).toThrow();
  expect(actionPhase('arrived', 'on_bus', 'dropoff')).toBe('dropoff');
});

test('pre-existing afternoon trips can preserve legacy boarding explicitly', () => {
  const trip = { type: 'afternoon_dropoff', status: 'in_progress' };
  trip.plan = buildTripPlan(trip, route, waypoints, { legacy: true });
  expect(getTripState(trip).pickupList.every(s => s.status === 'on_bus')).toBe(true);
});

test('stale, invalid and future timestamps cannot drive an ETA', () => {
  const now = Date.now();
  expect(locationFreshness(new Date(now - 120000), now).isFresh).toBe(true);
  expect(locationFreshness(new Date(now - 120001), now).isFresh).toBe(false);
  expect(locationFreshness(new Date(now + 30000), now).isFresh).toBe(true);
  expect(locationFreshness(new Date(now + 30001), now).isFresh).toBe(false);
  expect(locationFreshness(null, now)).toEqual({ ageSeconds: null, isFresh: false });
  expect(locationFreshness(new Date(now - 121000), now).isFresh).toBe(false);
  expect(locationFreshness('bad', now).isFresh).toBe(false);
  expect(locationFreshness(new Date(now + 60000), now).isFresh).toBe(false);
  expect(estimateStopETA(getTripState(make('morning_pickup')), 1, {
    lat: 1, lng: 30, recordedAt: new Date(now - 121000),
  }, now)).toBeNull();
});

test('boarding phases and invalid GPS coordinates cannot produce parent ETAs', () => {
  const location = { lat: 4, lng: 32, recordedAt: new Date() };
  expect(estimateStopETA(getTripState(make('afternoon_dropoff')), 1, location)).toBeNull();
  expect(estimateStopETA(getTripState(make('morning_pickup')), 1, { ...location, lat: null })).toBeNull();
  expect(estimateStopETA(getTripState(make('morning_pickup')), 1, { ...location, lng: 181 })).toBeNull();
});

test('start validation rejects empty rosters, missing school destinations and invalid home stops', () => {
  expect(validateTripPlan(buildTripPlan({ type: 'morning_pickup' }, { ...route, students: [] }, waypoints))).toMatch(/at least one student/);
  expect(validateTripPlan(buildTripPlan({ type: 'morning_pickup' }, route, []))).toMatch(/final outbound/);
  const plan = make('morning_pickup').plan;
  plan.stops[0].pickup.lat = null;
  expect(validateTripPlan(plan)).toMatch(/coordinates/);
});

test('ETA uses the authoritative afternoon drop-off destination and order', () => {
  const trip = make('afternoon_dropoff');
  const state = getTripState(trip, [log(1, 'check_in', 'pickup'), log(2, 'check_in', 'pickup', 2)]);
  const eta = estimateStopETA(state, 2, { lat: 3, lng: 31, recordedAt: new Date(), speed: 30 });
  expect(eta).toMatchObject({ phase: 'dropoff', distanceMeters: 0, stopsBefore: 0, totalMinutes: 1 });
});
