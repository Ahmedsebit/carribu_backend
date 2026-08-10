/**
 * FULL END-TO-END FLOW (on-demand integration test)
 *
 * Exercises the entire product journey against the REAL API + Socket.IO server,
 * using the current event contract, with a dedicated Postgres test DB:
 *
 *   1. Platform onboards a School and its school_admin.
 *   2. Admin logs in and provisions everything via the public/admin API:
 *        driver (temp password), parent (pending -> completes registration),
 *        vehicle, student, route (driver + student), and a scheduled trip.
 *   3. Parent registers an Expo push token (new PUT /auth/push-token) and the
 *        token is persisted; clearing it works too.
 *   4. Parent + driver connect over Socket.IO; parent tracks the trip.
 *   5. Driver starts the trip  -> parent gets a live `trip-started` socket event
 *        AND a phone push is dispatched (Expo push API call is captured).
 *   6. Driver sees the student pickup locations for the map
 *        (GET /driver/active-trip -> pickupList with lat/lng).
 *   7. Driver streams GPS -> parent receives `location-update` (bus on the map)
 *        and GET /location/my-bus returns the live position.
 *   8. Driver checks a student in -> parent gets `student-picked-up` + push.
 *   9. Driver ends the trip.
 *
 * Excluded from the default `npm test` run (needs a live server/socket +
 * Postgres). Run it explicitly:
 *   DB_NAME=school_transport_e2e npx jest tests/e2e/fullFlow.test.js --runInBand
 */
const request = require('supertest');
const { io: Client } = require('socket.io-client');
const { app, server } = require('../../server');
const { sequelize, School, User } = require('../../models');

// Parent pickup point + a bus GPS position ~100m away (inside the alert radius).
const PICKUP_LAT = -1.2641;
const PICKUP_LNG = 36.8053;
const BUS_LAT = -1.2700;
const BUS_LNG = 36.8100;

const EXPO_TOKEN = 'ExponentPushToken[e2e-parent-device-0001]';

let testPort;
let pushCalls = [];
let realFetch;

let adminToken, driverToken, parentToken;
let schoolId, driverId, parentId, vehicleId, studentId, routeId, tripId;

// supertest helper: attaches the JWT as a bearer token without embedding the
// literal header string (which the tooling redacts as a secret).
function auth(req, token) {
  return req.auth(token, { type: 'bearer' });
}

function connectClient(token) {
  return new Promise((resolve, reject) => {
    const client = Client(`http://localhost:${testPort}`, {
      auth: { token }, transports: ['websocket'], forceNew: true,
    });
    const timer = setTimeout(() => reject(new Error('Socket connection timeout')), 5000);
    client.on('connect', () => { clearTimeout(timer); resolve(client); });
    client.on('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

// Resolve with the first payload for `event`, or 'none' after `ms`.
function waitForEvent(socket, event, ms = 4000) {
  return Promise.race([
    new Promise((resolve) => socket.once(event, (data) => resolve(data))),
    new Promise((resolve) => setTimeout(() => resolve('none'), ms)),
  ]);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  // Capture every Expo push request so we can assert phone notifications fire,
  // without hitting the network.
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    pushCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return { json: async () => ({ data: { status: 'ok', id: 'e2e-ticket' } }) };
  };

  await sequelize.authenticate();
  await sequelize.sync({ force: true });

  // 1. Platform onboards a school (super-admin action, done directly here).
  const school = await School.create({
    name: 'Full Flow Academy', address: '1 Journey Rd', city: 'Nairobi',
    phone: '+254700900100', email: 'admin@fullflow.co.ke',
  });
  schoolId = school.id;

  await new Promise((resolve) => {
    server.listen(0, () => { testPort = server.address().port; resolve(); });
  });
});

afterAll(async () => {
  global.fetch = realFetch;
  server.close();
  await sequelize.close();
});

describe('Full end-to-end: school setup -> live trip tracking + notifications', () => {
  test('Admin account is registered and can log in', async () => {
    const reg = await request(app).post('/api/auth/register').send({
      email: 'admin@fullflow.co.ke', password: 'admin123',
      firstName: 'Ada', lastName: 'Admin', role: 'school_admin', schoolId,
    });
    expect(reg.status).toBe(201);

    const login = await request(app).post('/api/auth/login').send({
      email: 'admin@fullflow.co.ke', password: 'admin123',
    });
    expect(login.status).toBe(200);
    adminToken = login.body.token;
    expect(adminToken).toBeTruthy();
  });

  test('Admin creates a driver and the driver logs in with the temp password', async () => {
    const res = await auth(request(app).post('/api/drivers'), adminToken)
      .send({ email: 'driver@fullflow.co.ke', firstName: 'Dan', lastName: 'Driver', phone: '+254700900002' });
    expect(res.status).toBe(201);
    driverId = res.body.driver.id;
    const tempPassword = res.body.tempPassword;
    expect(tempPassword).toBeTruthy();

    const login = await request(app).post('/api/auth/login').send({
      email: 'driver@fullflow.co.ke', password: tempPassword,
    });
    expect(login.status).toBe(200);
    driverToken = login.body.token;
  });

  test('Admin creates a parent who completes registration (sets password)', async () => {
    const res = await auth(request(app).post('/api/parents'), adminToken)
      .send({
        email: 'parent@fullflow.co.ke', firstName: 'Pat', lastName: 'Parent',
        phone: '+254700900003', pickupAddress: 'Westlands',
        pickupLat: PICKUP_LAT, pickupLng: PICKUP_LNG,
      });
    expect(res.status).toBe(201);
    parentId = res.body.parent.id;

    const complete = await request(app).post('/api/auth/complete-registration').send({
      phone: '+254700900003', newPassword: 'parent123',
    });
    expect(complete.status).toBe(200);
    parentToken = complete.body.token;
    expect(parentToken).toBeTruthy();
  });

  test('Admin cannot reuse a driver or parent phone number', async () => {
    const duplicateDriver = await auth(request(app).post('/api/drivers'), adminToken)
      .send({ email: 'driver-two@fullflow.co.ke', firstName: 'Duplicate', lastName: 'Driver', phone: '0700900002' });
    expect(duplicateDriver.status).toBe(409);

    const duplicateParent = await auth(request(app).post('/api/parents'), adminToken)
      .send({
        email: 'parent-two@fullflow.co.ke', firstName: 'Duplicate', lastName: 'Parent',
        phone: '0700900003', pickupAddress: 'Westlands',
      });
    expect(duplicateParent.status).toBe(409);
  });

  test('Admin provisions vehicle, student, route and a scheduled trip', async () => {
    const vehicle = await auth(request(app).post('/api/vehicles'), adminToken)
      .send({ plateNumber: 'KDA FF01', make: 'Toyota', model: 'HiAce', year: 2023, capacity: 18, color: 'White', status: 'active', insuranceExpiry: '2028-01-01' });
    expect(vehicle.status).toBe(201);
    vehicleId = vehicle.body.vehicle.id;

    const student = await auth(request(app).post('/api/students'), adminToken)
      .send({ admissionNumber: 'FF-001', firstName: 'Kid', lastName: 'One', grade: 'Grade 3', parentId });
    expect(student.status).toBe(201);
    studentId = student.body.student.id;

    const route = await auth(request(app).post('/api/routes'), adminToken)
      .send({ name: 'FF Morning Route', description: 'full flow', vehicleId, driverId, type: 'morning', grades: ['Grade 3'], departureTime: '06:30', studentIds: [studentId] });
    expect(route.status).toBe(201);
    routeId = route.body.route.id;

    const today = new Date().toISOString().split('T')[0];
    const trip = await auth(request(app).post('/api/trips'), adminToken)
      .send({ routeId, driverId, vehicleId, type: 'morning_pickup', scheduledDate: today });
    expect(trip.status).toBe(201);
    tripId = trip.body.trip.id;
    expect(trip.body.trip.status).toBe('scheduled');
  });

  test('Parent registers an Expo push token (persisted) and can clear it', async () => {
    const save = await auth(request(app).put('/api/auth/push-token'), parentToken)
      .send({ pushToken: EXPO_TOKEN });
    expect(save.status).toBe(200);

    let dbUser = await User.findByPk(parentId, { attributes: ['expoPushToken'] });
    expect(dbUser.expoPushToken).toBe(EXPO_TOKEN);

    // Clearing (logout) stores null...
    const clear = await auth(request(app).put('/api/auth/push-token'), parentToken)
      .send({ pushToken: null });
    expect(clear.status).toBe(200);
    dbUser = await User.findByPk(parentId, { attributes: ['expoPushToken'] });
    expect(dbUser.expoPushToken).toBeNull();

    // ...re-register so the rest of the flow can deliver phone pushes.
    await auth(request(app).put('/api/auth/push-token'), parentToken)
      .send({ pushToken: EXPO_TOKEN });
  });

  test('Driver starts the trip: parent gets a live event AND a phone push', async () => {
    const parentSocket = await connectClient(parentToken);
    parentSocket.emit('track-trip', tripId);
    await wait(200);

    pushCalls = [];
    const started = waitForEvent(parentSocket, 'trip-started');

    const res = await auth(request(app).put(`/api/trips/${tripId}/start`), driverToken);
    expect(res.status).toBe(200);
    expect(res.body.trip.status).toBe('in_progress');

    const payload = await started;
    expect(payload).not.toBe('none');
    expect(payload.tripId).toBe(tripId);
    expect(payload.driverName).toContain('Dan');

    // Phone push dispatched to the parent's Expo token.
    await wait(400);
    const push = pushCalls.find((c) => c.body && c.body.to === EXPO_TOKEN);
    expect(push).toBeTruthy();
    expect(push.body.title).toMatch(/Trip Started/i);

    parentSocket.disconnect();
  });

  test('Driver sees each student pickup location on the map (active-trip)', async () => {
    const res = await auth(request(app).get('/api/driver/active-trip'), driverToken);
    expect(res.status).toBe(200);
    expect(res.body.activeTrip).toBeTruthy();
    const stops = res.body.activeTrip.pickupList;
    expect(stops.length).toBe(1);
    expect(Number(stops[0].pickupLat)).toBeCloseTo(PICKUP_LAT, 4);
    expect(Number(stops[0].pickupLng)).toBeCloseTo(PICKUP_LNG, 4);
    expect(stops[0].status).toBe('pending');
  });

  test('Driver GPS reaches the parent map (location-update) and /my-bus', async () => {
    const parentSocket = await connectClient(parentToken);
    parentSocket.emit('track-trip', tripId);
    await wait(200);

    const update = waitForEvent(parentSocket, 'location-update');
    const res = await auth(request(app).post('/api/location/update'), driverToken)
      .send({ tripId, lat: BUS_LAT, lng: BUS_LNG, speed: 35, heading: 90 });
    expect(res.status).toBe(201);

    const payload = await update;
    expect(payload).not.toBe('none');
    expect(payload.tripId).toBe(tripId);
    expect(payload.lat).toBeCloseTo(BUS_LAT, 4);

    // Parent's "where is my child's bus" endpoint returns the live position.
    const myBus = await auth(request(app).get('/api/location/my-bus'), parentToken);
    expect(myBus.status).toBe(200);
    expect(myBus.body.total).toBeGreaterThanOrEqual(1);
    const activeBus = myBus.body.activeBuses.find((b) => b.tripId === tripId);
    expect(activeBus).toBeTruthy();
    expect(Number(activeBus.location.lat)).toBeCloseTo(BUS_LAT, 3);
    expect(Number(activeBus.location.lng)).toBeCloseTo(BUS_LNG, 3);

    parentSocket.disconnect();
  });

  test('Driver checks the student in: parent gets picked-up event + push', async () => {
    const parentSocket = await connectClient(parentToken);
    await wait(200);

    pushCalls = [];
    const pickedUp = waitForEvent(parentSocket, 'student-picked-up');

    const res = await auth(request(app).post(`/api/trips/${tripId}/log`), driverToken)
      .send({ studentId, action: 'check_in', lat: PICKUP_LAT, lng: PICKUP_LNG });
    expect(res.status).toBe(201);

    const payload = await pickedUp;
    expect(payload).not.toBe('none');
    expect(payload.studentName).toContain('Kid');

    await wait(400);
    const push = pushCalls.find((c) => c.body && c.body.to === EXPO_TOKEN);
    expect(push).toBeTruthy();
    expect(push.body.title).toMatch(/Picked Up/i);

    parentSocket.disconnect();
  });

  test('Driver ends the trip', async () => {
    const res = await auth(request(app).put(`/api/trips/${tripId}/end`), driverToken);
    expect(res.status).toBe(200);
    expect(res.body.trip.status).toBe('completed');
  });
});
