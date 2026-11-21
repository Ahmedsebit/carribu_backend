const jwt = require('jsonwebtoken');

let mockServer;
jest.mock('socket.io', () => ({
  Server: jest.fn().mockImplementation(() => {
    mockServer = {
      handlers: {},
      use: jest.fn(fn => { mockServer.authenticate = fn; }),
      on: jest.fn((event, fn) => { mockServer.handlers[event] = fn; }),
      in: jest.fn(() => ({ fetchSockets: async () => mockServer.sockets })),
      sockets: [],
    };
    return mockServer;
  }),
}));
jest.mock('../models', () => ({
  User: { findByPk: jest.fn() }, Trip: { findByPk: jest.fn() },
  Route: {}, Student: { findAll: jest.fn() }, ParentSchool: { findOne: jest.fn() },
}));
jest.mock('../services/push', () => ({ sendPushToUser: jest.fn() }));
jest.mock('../services/locationTracking', () => ({ recordDriverLocation: jest.fn() }));

const { User, Trip, Student, ParentSchool } = require('../models');
const { initSocket, notifyTrip } = require('../socket');
const { recordDriverLocation } = require('../services/locationTracking');
const secret = 'socket-authorization-tests-only';
let originalSecret, account, trip;

beforeAll(() => { originalSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret; });
afterAll(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});
beforeEach(() => {
  jest.clearAllMocks();
  account = { id: 5, role: 'parent', schoolId: 99, isActive: true };
  trip = { id: 10, routeId: 9, driverId: 3, route: { id: 9, schoolId: 4 }, plan: { stops: [{ studentId: 11, parentId: 5 }] } };
  User.findByPk.mockImplementation(async () => account);
  Trip.findByPk.mockResolvedValue(trip);
  ParentSchool.findOne.mockResolvedValue({ id: 1 });
  Student.findAll.mockResolvedValue([{ id: 11 }]);
  initSocket({});
});

async function connect(claims = {}, options = {}) {
  const socket = {
    handshake: { auth: { token: jwt.sign({ ...account, ...claims }, secret, options) } },
    handlers: {}, rooms: new Set(), emit: jest.fn(),
    join: jest.fn(room => { socket.rooms.add(room); }),
    leave: jest.fn(room => { socket.rooms.delete(room); }),
    on: jest.fn((event, handler) => { socket.handlers[event] = handler; }),
  };
  const next = jest.fn();
  await mockServer.authenticate(socket, next);
  if (!next.mock.calls[0][0]) {
    mockServer.handlers.connection(socket);
    mockServer.sockets.push(socket);
  }
  return { socket, next };
}

test.each(['join-trip', 'track-trip'])('%s permits a multi-school parent with a frozen-roster child', async event => {
  const { socket } = await connect();
  const ack = jest.fn();
  await socket.handlers[event](10, ack);
  expect(socket.join).toHaveBeenCalledWith('trip:10');
  expect(ack).toHaveBeenCalledWith({ accepted: true, tripId: 10 });
});

test.each(['join-trip', 'track-trip'])('%s denies arbitrary rooms to unassigned drivers and foreign-school staff', async event => {
  account = { id: 6, role: 'driver', schoolId: 4, isActive: true };
  const { socket } = await connect();
  const ack = jest.fn();
  await socket.handlers[event](10, ack);
  expect(ack).toHaveBeenLastCalledWith(expect.objectContaining({ accepted: false }));
  expect(socket.rooms.has('trip:10')).toBe(false);
  account = { ...account, role: 'school_admin', schoolId: 99 };
  await socket.handlers[event](10, ack);
  expect(ack).toHaveBeenLastCalledWith(expect.objectContaining({ accepted: false }));
  expect(socket.rooms.has('trip:10')).toBe(false);
});

test('socket authentication uses current account authority and rejects expired/deactivated accounts', async () => {
  const { socket } = await connect({ role: 'super_admin', schoolId: 4 });
  expect(socket.user).toMatchObject({ role: 'parent', schoolId: 99 });
  expect((await connect({}, { expiresIn: -1 })).next).toHaveBeenCalledWith(expect.any(Error));
  account.isActive = false;
  expect((await connect()).next).toHaveBeenCalledWith(expect.any(Error));
});

test.each(['revoked membership', 'deactivated account', 'removed child'])('existing room cannot receive broadcasts after %s', async reason => {
  const { socket } = await connect();
  await socket.handlers['track-trip'](10);
  socket.emit.mockClear();
  if (reason === 'revoked membership') ParentSchool.findOne.mockResolvedValue(null);
  if (reason === 'deactivated account') account.isActive = false;
  if (reason === 'removed child') Student.findAll.mockResolvedValue([]);
  await notifyTrip(10, 'location-update', { lat: 1, lng: 30 });
  expect(socket.emit).not.toHaveBeenCalledWith('location-update', expect.anything());
  expect(socket.leave).toHaveBeenCalledWith('trip:10');
});

test('a reassigned driver cannot receive broadcasts from the previously assigned trip', async () => {
  account = { id: 3, role: 'driver', schoolId: 4, isActive: true };
  const { socket } = await connect();
  await socket.handlers['join-trip'](10);
  trip.driverId = 6;
  await notifyTrip(10, 'location-update', { lat: 1, lng: 30 });
  expect(socket.emit).not.toHaveBeenCalledWith('location-update', expect.anything());
  expect(socket.leave).toHaveBeenCalledWith('trip:10');
});

test('a deactivated driver cannot keep uploading locations through an existing socket', async () => {
  account = { id: 3, role: 'driver', schoolId: 4, isActive: true };
  const { socket } = await connect();
  account.isActive = false;
  const ack = jest.fn();
  await socket.handlers['driver-location']({ tripId: 10, lat: 1, lng: 30 }, ack);
  expect(ack).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }));
  expect(recordDriverLocation).not.toHaveBeenCalled();
});

test('authorised broadcasts retain their event order while access checks are asynchronous', async () => {
  const { socket } = await connect();
  await socket.handlers['track-trip'](10);
  socket.emit.mockClear();
  await Promise.all([
    notifyTrip(10, 'location-update', { sequence: 1 }),
    notifyTrip(10, 'location-update', { sequence: 2 }),
  ]);
  expect(socket.emit.mock.calls).toEqual([
    ['location-update', { sequence: 1 }], ['location-update', { sequence: 2 }],
  ]);
});

test('failed access lookups fail closed without disclosing a broadcast', async () => {
  const { socket } = await connect();
  await socket.handlers['track-trip'](10);
  User.findByPk.mockRejectedValue(new Error('Synthetic database failure'));
  await notifyTrip(10, 'location-update', { lat: 1, lng: 30 });
  expect(socket.emit).not.toHaveBeenCalledWith('location-update', expect.anything());
  expect(socket.leave).toHaveBeenCalledWith('trip:10');
});
