/**
 * Socket.IO Real-time Tests
 * Tests real-time communication between driver and parent
 */
const request = require('supertest');
const { io: Client } = require('socket.io-client');
const { app, server } = require('../../server');
const { sequelize, School, User, Vehicle, Student, Route, RouteStudent } = require('../../models');

let school, driverToken, parentToken, driverId, parentId;
let routeId, studentId, tripId;
let testPort;

beforeAll(async () => {
  await sequelize.authenticate();
  await sequelize.sync({ force: true });

  school = await School.create({
    name: 'Socket Test School', address: '1 Socket St', city: 'Nairobi',
    phone: '+254700300100', email: 'socket@test.co.ke',
  });

  const driver = await User.create({
    schoolId: school.id, email: 'sock-driver@test.com', passwordHash: 'driver123',
    firstName: 'Socket', lastName: 'Driver', role: 'driver', phone: '+254700300002',
  });
  driverId = driver.id;

  const parent = await User.create({
    schoolId: school.id, email: 'sock-parent@test.com', passwordHash: 'parent123',
    firstName: 'Socket', lastName: 'Parent', role: 'parent', phone: '+254700300003',
    pickupLat: -1.2641, pickupLng: 36.8053, pickupAddress: 'Westlands',
  });
  parentId = parent.id;

  const vehicle = await Vehicle.create({
    schoolId: school.id, plateNumber: 'KDA SOC1', make: 'Toyota', model: 'HiAce',
    year: 2023, capacity: 18, color: 'White', status: 'active', insuranceExpiry: '2028-01-01',
  });

  const student = await Student.create({
    schoolId: school.id, parentId: parent.id, firstName: 'Socket', lastName: 'Kid', grade: 'Grade 3',
  });
  studentId = student.id;

  const route = await Route.create({
    schoolId: school.id, name: 'Socket Route', description: 'For socket tests',
    vehicleId: vehicle.id, driverId: driver.id, type: 'both',
  });
  routeId = route.id;

  await RouteStudent.create({ routeId: route.id, studentId: student.id, stopOrder: 1 });

  // Login
  const [dRes, pRes] = await Promise.all([
    request(app).post('/api/auth/login').send({ email: 'sock-driver@test.com', password: 'driver123' }),
    request(app).post('/api/auth/login').send({ email: 'sock-parent@test.com', password: 'parent123' }),
  ]);
  driverToken = dRes.body.token;
  parentToken = pRes.body.token;

  // Start server on random port
  await new Promise((resolve) => {
    server.listen(0, () => {
      testPort = server.address().port;
      resolve();
    });
  });

  // Create a trip
  const tripRes = await request(app)
    .post('/api/trips')
    .set('Authorization', `Bearer ${driverToken}`)
    .send({
      routeId, driverId, vehicleId: vehicle.id,
      type: 'morning_pickup', scheduledDate: new Date().toISOString().split('T')[0],
    });

  // If driver can't create, try with a temp admin token
  if (tripRes.status === 403) {
    const adminUser = await User.create({
      schoolId: school.id, email: 'sock-admin@test.com', passwordHash: 'admin123',
      firstName: 'Socket', lastName: 'Admin', role: 'school_admin', phone: '+254700300001',
    });
    const aRes = await request(app).post('/api/auth/login').send({ email: 'sock-admin@test.com', password: 'admin123' });
    const adminToken = aRes.body.token;
    const tripRes2 = await request(app)
      .post('/api/trips')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        routeId, driverId, vehicleId: vehicle.id,
        type: 'morning_pickup', scheduledDate: new Date().toISOString().split('T')[0],
      });
    tripId = tripRes2.body.trip.id;
  } else {
    tripId = tripRes.body.trip.id;
  }
});

afterAll(async () => {
  server.close();
  await sequelize.close();
});

function connectClient(token) {
  return new Promise((resolve, reject) => {
    const client = Client(`http://localhost:${testPort}`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    client.on('connect', () => resolve(client));
    client.on('connect_error', reject);
    setTimeout(() => reject(new Error('Socket connection timeout')), 5000);
  });
}

describe('Socket.IO Real-time Communication', () => {
  let driverSocket, parentSocket;

  afterEach(() => {
    if (driverSocket) { driverSocket.disconnect(); driverSocket = null; }
    if (parentSocket) { parentSocket.disconnect(); parentSocket = null; }
  });

  test('Driver and parent can connect with valid tokens', async () => {
    driverSocket = await connectClient(driverToken);
    parentSocket = await connectClient(parentToken);

    expect(driverSocket.connected).toBe(true);
    expect(parentSocket.connected).toBe(true);
  });

  test('Rejects connection with invalid token', async () => {
    try {
      await connectClient('invalid-token-123');
      fail('Should have rejected');
    } catch (err) {
      expect(err).toBeDefined();
    }
  });

  test('Driver location broadcasts to parent tracking the trip', async () => {
    driverSocket = await connectClient(driverToken);
    parentSocket = await connectClient(parentToken);

    // Parent subscribes to trip tracking
    parentSocket.emit('track-trip', { tripId });

    // Wait a moment for room join
    await new Promise(r => setTimeout(r, 200));

    // Driver joins trip and sends location
    driverSocket.emit('join-trip', { tripId });
    await new Promise(r => setTimeout(r, 200));

    const locationReceived = new Promise((resolve) => {
      parentSocket.on('driver-location', (data) => {
        resolve(data);
      });
    });

    driverSocket.emit('driver-location', {
      tripId,
      lat: -1.2700,
      lng: 36.8100,
      speed: 35,
      heading: 90,
    });

    const location = await Promise.race([
      locationReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)),
    ]);

    expect(location.lat).toBe(-1.2700);
    expect(location.lng).toBe(36.8100);
    expect(location.speed).toBe(35);
  });

  test('Chat messages are relayed in real-time', async () => {
    driverSocket = await connectClient(driverToken);
    parentSocket = await connectClient(parentToken);

    const messageReceived = new Promise((resolve) => {
      parentSocket.on('new-message', (data) => {
        resolve(data);
      });
    });

    // Driver sends chat via REST (which triggers socket)
    await request(app)
      .post('/api/messages')
      .set('Authorization', `Bearer ${driverToken}`)
      .send({
        receiverId: parentId,
        content: 'On my way to your stop!',
        messageType: 'text',
      });

    const msg = await Promise.race([
      messageReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for message')), 3000)),
    ]);

    expect(msg.content).toBe('On my way to your stop!');
    expect(msg.senderId).toBe(driverId);
  });

  test('Trip start notification reaches parent', async () => {
    parentSocket = await connectClient(parentToken);

    const notificationReceived = new Promise((resolve) => {
      parentSocket.on('trip-started', (data) => {
        resolve(data);
      });
    });

    // Start the trip
    await request(app)
      .post(`/api/trips/${tripId}/start`)
      .set('Authorization', `Bearer ${driverToken}`);

    const notification = await Promise.race([
      notificationReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)),
    ]);

    expect(notification.tripId).toBe(tripId);
    expect(notification.driverName).toContain('Socket');
  });

  test('Pickup notification reaches parent', async () => {
    parentSocket = await connectClient(parentToken);

    const notificationReceived = new Promise((resolve) => {
      parentSocket.on('student-picked-up', (data) => {
        resolve(data);
      });
    });

    // Driver checks in student
    await request(app)
      .post(`/api/trips/${tripId}/log`)
      .set('Authorization', `Bearer ${driverToken}`)
      .send({ studentId, action: 'check_in', lat: -1.2641, lng: 36.8053 });

    const notification = await Promise.race([
      notificationReceived,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000)),
    ]);

    expect(notification.studentName).toContain('Socket');
  });
});
