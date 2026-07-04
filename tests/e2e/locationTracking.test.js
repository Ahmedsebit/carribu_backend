/**
 * Location Tracking & Proximity Notification Integration Tests
 *
 * Covers the parent live-tracking fixes:
 *  1. The REST POST /api/location/update endpoint broadcasts a `location-update`
 *     socket event to parents who joined the trip room (the fallback emit added
 *     so the map stays live even if the driver's direct socket emit is dropped).
 *  2. `location-update` is scoped to the trip room: a parent who has NOT joined
 *     does not receive it. This is the server contract the parent app relies on,
 *     and the reason the client must re-`track-trip` after every reconnect.
 *  3. A GPS position near a parent's pickup point pushes a real-time
 *     `driver-approaching` notification to that parent (notifyUser), not just a
 *     stored message.
 */
const request = require('supertest');
const { io: Client } = require('socket.io-client');
const { app, server } = require('../../server');
const { sequelize, School, User, Vehicle, Student, Route, RouteStudent, Trip } = require('../../models');

let school, driverToken, parentToken, parent2Token;
let driverId, parentId, parent2Id;
let routeId, studentId, vehicleId, tripId;
let testPort;

// Parent 1 pickup point. The "near" location below sits ~100m from here.
const PICKUP_LAT = -1.2641;
const PICKUP_LNG = 36.8053;
// A location far from every pickup so it triggers no proximity alerts.
const FAR_LAT = -1.3200;
const FAR_LNG = 36.7400;
// A location ~100m north of parent 1's pickup (within the 200m alert radius).
const NEAR_LAT = -1.2650;
const NEAR_LNG = 36.8053;

beforeAll(async () => {
  await sequelize.authenticate();
  await sequelize.sync({ force: true });

  school = await School.create({
    name: 'Tracking Test School', address: '1 Tracking Ave', city: 'Nairobi',
    phone: '+254700400100', email: 'tracking@test.co.ke',
  });

  const driver = await User.create({
    schoolId: school.id, email: 'track-driver@test.com', passwordHash: 'driver123',
    firstName: 'Track', lastName: 'Driver', role: 'driver', phone: '+254700400002',
  });
  driverId = driver.id;

  const parent = await User.create({
    schoolId: school.id, email: 'track-parent@test.com', passwordHash: 'parent123',
    firstName: 'Track', lastName: 'Parent', role: 'parent', phone: '+254700400003',
    pickupLat: PICKUP_LAT, pickupLng: PICKUP_LNG, pickupAddress: 'Westlands',
  });
  parentId = parent.id;

  // A second, unrelated parent (different pickup, not tracking the trip).
  const parent2 = await User.create({
    schoolId: school.id, email: 'track-parent2@test.com', passwordHash: 'parent123',
    firstName: 'Other', lastName: 'Parent', role: 'parent', phone: '+254700400004',
    pickupLat: -1.3500, pickupLng: 36.7000, pickupAddress: 'Karen',
  });
  parent2Id = parent2.id;

  const vehicle = await Vehicle.create({
    schoolId: school.id, plateNumber: 'KDA TRK1', make: 'Toyota', model: 'HiAce',
    year: 2023, capacity: 18, color: 'White', status: 'active', insuranceExpiry: '2028-01-01',
  });
  vehicleId = vehicle.id;

  const student = await Student.create({
    schoolId: school.id, parentId: parent.id, firstName: 'Track', lastName: 'Kid', grade: 'Grade 3',
  });
  studentId = student.id;

  const route = await Route.create({
    schoolId: school.id, name: 'Tracking Route', description: 'For tracking tests',
    vehicleId: vehicle.id, driverId: driver.id, type: 'both',
  });
  routeId = route.id;

  await RouteStudent.create({ routeId: route.id, studentId: student.id, stopOrder: 1 });

  // Create the trip already in progress so /api/location/update accepts it.
  const trip = await Trip.create({
    routeId: route.id, driverId: driver.id, vehicleId: vehicle.id,
    type: 'morning_pickup', scheduledDate: new Date().toISOString().split('T')[0],
    status: 'in_progress', startedAt: new Date(),
  });
  tripId = trip.id;

  const [dRes, pRes, p2Res] = await Promise.all([
    request(app).post('/api/auth/login').send({ email: 'track-driver@test.com', password: 'driver123' }),
    request(app).post('/api/auth/login').send({ email: 'track-parent@test.com', password: 'parent123' }),
    request(app).post('/api/auth/login').send({ email: 'track-parent2@test.com', password: 'parent123' }),
  ]);
  driverToken = dRes.body.token;
  parentToken = pRes.body.token;
  parent2Token = p2Res.body.token;

  await new Promise((resolve) => {
    server.listen(0, () => { testPort = server.address().port; resolve(); });
  });
});

afterAll(async () => {
  server.close();
  await sequelize.close();
});

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

// Resolves with the first payload for `event`, or 'none' after `ms`.
function waitForEvent(socket, event, ms = 3000) {
  return Promise.race([
    new Promise((resolve) => socket.once(event, (data) => resolve(data))),
    new Promise((resolve) => setTimeout(() => resolve('none'), ms)),
  ]);
}

function postLocation(token, body) {
  return request(app)
    .post('/api/location/update')
    .set('Authorization', `Bearer ${token}`)
    .send({ tripId, ...body });
}

describe('Location tracking & proximity notifications', () => {
  let driverSocket, parentSocket, parent2Socket;

  afterEach(() => {
    [driverSocket, parentSocket, parent2Socket].forEach((s) => s && s.disconnect());
    driverSocket = parentSocket = parent2Socket = null;
  });

  test('REST location update broadcasts location-update to a tracking parent', async () => {
    parentSocket = await connectClient(parentToken);
    parentSocket.emit('track-trip', tripId);
    await new Promise((r) => setTimeout(r, 200)); // allow room join

    const received = waitForEvent(parentSocket, 'location-update');
    const res = await postLocation(driverToken, { lat: FAR_LAT, lng: FAR_LNG, speed: 40, heading: 90 });
    expect(res.status).toBe(201);

    const payload = await received;
    expect(payload).not.toBe('none');
    expect(payload.tripId).toBe(tripId);
    expect(payload.lat).toBeCloseTo(FAR_LAT, 4);
    expect(payload.lng).toBeCloseTo(FAR_LNG, 4);
  });

  test('location-update is scoped to the trip room (untracked parent gets nothing)', async () => {
    // parent2 connects but never emits track-trip, so it must not receive
    // location updates for this trip even though it shares the same socket server.
    parent2Socket = await connectClient(parent2Token);
    await new Promise((r) => setTimeout(r, 200));

    const received = waitForEvent(parent2Socket, 'location-update', 1500);
    const res = await postLocation(driverToken, { lat: FAR_LAT, lng: FAR_LNG, speed: 40, heading: 90 });
    expect(res.status).toBe(201);

    expect(await received).toBe('none');
  });

  test('a parent only receives updates again after re-joining on reconnect', async () => {
    // Simulates the reconnect bug + fix: trip-room membership is per-connection,
    // so a reconnected socket must re-emit track-trip (the client now does this
    // automatically) before location flows again.
    parentSocket = await connectClient(parentToken);
    parentSocket.emit('track-trip', tripId);
    await new Promise((r) => setTimeout(r, 200));
    let received = waitForEvent(parentSocket, 'location-update');
    await postLocation(driverToken, { lat: FAR_LAT, lng: FAR_LNG });
    expect(await received).not.toBe('none');

    // Reconnect as a brand-new connection WITHOUT re-tracking -> no updates.
    parentSocket.disconnect();
    parentSocket = await connectClient(parentToken);
    await new Promise((r) => setTimeout(r, 200));
    received = waitForEvent(parentSocket, 'location-update', 1500);
    await postLocation(driverToken, { lat: FAR_LAT, lng: FAR_LNG });
    expect(await received).toBe('none');

    // Re-emit track-trip (what the client does on reconnect) -> updates resume.
    parentSocket.emit('track-trip', tripId);
    await new Promise((r) => setTimeout(r, 200));
    received = waitForEvent(parentSocket, 'location-update');
    await postLocation(driverToken, { lat: FAR_LAT, lng: FAR_LNG });
    expect(await received).not.toBe('none');
  });

  test('a GPS position near the pickup pushes a live driver-approaching alert', async () => {
    // The parent does NOT need to join the trip room: proximity alerts are
    // delivered to the parent's personal room via notifyUser.
    parentSocket = await connectClient(parentToken);
    await new Promise((r) => setTimeout(r, 200));

    const received = waitForEvent(parentSocket, 'driver-approaching', 4000);
    const res = await postLocation(driverToken, { lat: NEAR_LAT, lng: NEAR_LNG, speed: 20, heading: 180 });
    expect(res.status).toBe(201);

    const payload = await received;
    expect(payload).not.toBe('none');
    expect(payload.tripId).toBe(tripId);
    expect(payload.message).toEqual(expect.stringMatching(/approach/i));
  });
});
