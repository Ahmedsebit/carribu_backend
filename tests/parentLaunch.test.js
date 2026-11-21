const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');

jest.mock('../models', () => ({
  sequelize: { transaction: jest.fn(), query: jest.fn() },
  User: { findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), update: jest.fn(), create: jest.fn() },
  School: {}, ParentSchool: { findOne: jest.fn(), findAll: jest.fn(), findOrCreate: jest.fn() },
  ParentActivationInvitation: { create: jest.fn(), update: jest.fn(), findOne: jest.fn() },
  Student: { findAll: jest.fn() }, Route: { findOne: jest.fn(), findAll: jest.fn() },
  RouteStudent: { findAll: jest.fn() }, Trip: { findAll: jest.fn(), findByPk: jest.fn() },
  Message: { create: jest.fn(), findByPk: jest.fn(), findOne: jest.fn(), findAll: jest.fn(), update: jest.fn() },
}));
jest.mock('../middleware/auditLog', () => ({ logLogin: jest.fn() }));
jest.mock('../services/tripWorkflow', () => ({ lockSchool: jest.fn() }));
jest.mock('../services/notificationOutbox', () => ({ enqueueMessageNotification: jest.fn() }));
jest.mock('../services/tripAccess', () => ({ getAccessibleTrip: jest.fn() }));
jest.mock('../services/tripReminders', () => ({ schoolDate: () => '2026-11-21' }));

const models = require('../models');
const { enqueueMessageNotification } = require('../services/notificationOutbox');
const { getAccessibleTrip } = require('../services/tripAccess');
const app = express();
app.use(express.json());
app.use('/auth', require('../routes/auth'));
app.use('/parents', require('../routes/parents'));
app.use('/messages', require('../routes/messages'));
const secret = 'parent-launch-tests-only';
let originalSecret, accounts, invitations, messages, transaction, membershipActive;
const row = data => {
  const value = { ...data };
  value.save = jest.fn(async () => value);
  value.update = jest.fn(async updates => Object.assign(value, updates));
  value.toJSON = () => Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item !== 'function'));
  return value;
};
const matches = (value, where) => Object.entries(where).every(([key, expected]) => {
  if (expected && typeof expected === 'object' && expected[Op.in]) return expected[Op.in].includes(value[key]);
  if (Array.isArray(expected)) return expected.includes(value[key]);
  return value[key] === expected;
});
const auth = (method, url, id = 1) => request(app)[method](url)
  .set('Authorization', `Bearer ${jwt.sign({ id }, secret)}`);
const parentPhone = '+254712345678';

beforeAll(() => { originalSecret = process.env.JWT_SECRET; process.env.JWT_SECRET = secret; });
afterAll(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});
beforeEach(() => {
  jest.resetAllMocks();
  transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' }, afterCommit: jest.fn() };
  models.sequelize.transaction.mockImplementation(callback => callback(transaction));
  membershipActive = true;
  accounts = new Map([
    [1, row({ id: 1, schoolId: 4, role: 'school_admin', isActive: true })],
    [3, row({ id: 3, schoolId: 4, role: 'driver', isActive: true, firstName: 'Test', lastName: 'Driver' })],
    [5, row({ id: 5, schoolId: 99, role: 'parent', isActive: true, mustSetPassword: true, phone: parentPhone, firstName: 'Test', lastName: 'Parent' })],
    [7, row({ id: 7, schoolId: 99, role: 'driver', isActive: true })],
    [8, row({ id: 8, schoolId: 4, role: 'parent', isActive: true, mustSetPassword: false })],
    [9, row({ id: 9, schoolId: 4, role: 'driver', isActive: true })],
    [10, row({ id: 10, schoolId: 99, role: 'school_admin', isActive: true })],
  ]);
  models.User.findByPk.mockImplementation(async id => accounts.get(Number(id)));
  models.User.findOne.mockImplementation(async ({ where }) => [...accounts.values()].find(account => matches(account, where)));
  models.User.findAll.mockImplementation(async ({ where }) => [...accounts.values()].filter(account => matches(account, where)));
  models.User.create.mockImplementation(async data => {
    const account = row({ id: 12, isActive: true, ...data });
    accounts.set(account.id, account); return account;
  });
  models.ParentSchool.findOne.mockImplementation(async ({ where }) =>
    membershipActive && [5, 8].includes(where.parentId) && where.schoolId === 4 ? { id: 1 } : null);
  models.ParentSchool.findAll.mockImplementation(async ({ where }) => {
    if (typeof where.parentId === 'number') return membershipActive ? [{ schoolId: 4 }] : [];
    return membershipActive ? [{ parentId: 5 }, { parentId: 8 }] : [];
  });
  models.Route.findOne.mockImplementation(async options => {
    if (options.where.id && Number(options.where.id) !== 20) return null;
    if (options.where.driverId && options.where.driverId !== 3) return null;
    if (options.where.schoolId !== 4) return null;
    if (options.include?.[0]?.where?.parentId && options.include[0].where.parentId !== 5) return null;
    return row({ id: 20, schoolId: 4, driverId: 3, students: [] });
  });
  models.Student.findAll.mockResolvedValue([]);
  models.Trip.findAll.mockResolvedValue([]);
  invitations = [];
  models.ParentActivationInvitation.create.mockImplementation(async data => {
    const invitation = row({ id: invitations.length + 1, consumedAt: null, ...data });
    invitations.push(invitation);
    return invitation;
  });
  models.ParentActivationInvitation.findOne.mockImplementation(async ({ where }) => invitations.find(invitation => matches(invitation, where)));
  models.ParentActivationInvitation.update.mockImplementation(async (updates, { where }) => {
    invitations.filter(invitation => matches(invitation, where)).forEach(invitation => Object.assign(invitation, updates));
  });
  messages = [];
  models.Message.create.mockImplementation(async data => {
    const message = row({ id: messages.length + 1, createdAt: new Date(), ...data });
    messages.push(message);
    return message;
  });
  models.Message.findByPk.mockImplementation(async id => messages.find(message => message.id === id));
  models.Message.findOne.mockImplementation(async ({ where }) => messages.find(message => matches(message, where)));
  models.Message.findAll.mockResolvedValue([]);
  getAccessibleTrip.mockResolvedValue({ trip: { route: { schoolId: 4 } } });
});

describe('school-issued activation proof', () => {
  test('phone alone cannot reveal an account or set its password', async () => {
    expect((await request(app).post('/auth/registration-status').send({ phone: parentPhone })).status).toBe(403);
    expect((await request(app).post('/auth/complete-registration').send({ phone: parentPhone, newPassword: 'synthetic-password' })).status).toBe(403);
    expect(accounts.get(5).save).not.toHaveBeenCalled();
  });
  test('a pending parent cannot bypass activation with an existing signed token', async () => {
    expect((await auth('get', '/messages/conversations', 5)).status).toBe(401);
  });
  test('public self-registration cannot bypass school activation when that account is subsequently enrolled', async () => {
    const registered = await request(app).post('/auth/register').send({
      email: 'synthetic@example.test', password: 'synthetic-password', firstName: 'Test', lastName: 'Parent',
    });
    expect(registered.status).toBe(201);
    expect(registered.body.user.mustSetPassword).toBe(true);
    expect(registered.body.token).toBeUndefined();
    accounts.get(12).schoolId = 4;
    expect((await auth('get', '/messages/conversations', 12)).status).toBe(401);
  });
  test('enrolling an older standalone public account requires invitation activation instead of trusting its password', async () => {
    const legacy = row({ id: 12, schoolId: null, role: 'parent', isActive: true, mustSetPassword: false,
      phone: parentPhone, email: 'synthetic@example.test' });
    models.User.findAll.mockResolvedValue([legacy]);
    models.ParentSchool.findOne.mockResolvedValue(null);
    models.ParentSchool.findOrCreate.mockResolvedValue([{ isActive: true }, true]);
    const res = await auth('post', '/parents').send({
      email: legacy.email, phone: parentPhone, firstName: 'Test', lastName: 'Parent',
    });
    expect(res.status).toBe(200);
    expect(legacy.mustSetPassword).toBe(true);
    expect(res.body.parent.mustSetPassword).toBe(true);
  });
  test('issuer permissions are rechecked inside the invitation transaction', async () => {
    models.User.findByPk.mockResolvedValueOnce(accounts.get(1))
      .mockResolvedValueOnce({ ...accounts.get(1), role: 'driver' });
    expect((await auth('post', '/parents/5/activation-invitation')).status).toBe(403);
    expect(invitations).toHaveLength(0);
  });
  test('only active linked-school staff may issue a code, and activated accounts cannot be reset this way', async () => {
    accounts.get(5).mustSetPassword = false;
    expect((await auth('post', '/parents/5/activation-invitation', 5)).status).toBe(403);
    accounts.get(5).mustSetPassword = true;
    expect((await auth('post', '/parents/5/activation-invitation', 10)).status).toBe(404);
    membershipActive = false;
    expect((await auth('post', '/parents/5/activation-invitation')).status).toBe(404);
    membershipActive = true;
    expect((await auth('post', '/parents/8/activation-invitation')).status).toBe(409);
    expect(invitations).toHaveLength(0);
  });
  test('a code is account-bound, is stored only as a hash, and is consumed with password activation', async () => {
    accounts.get(5).expoPushToken = 'synthetic-old-device';
    accounts.get(5).fcmPushToken = 'synthetic-old-fcm-device';
    const oldToken = jwt.sign({ id: 5 }, secret);
    const issued = await auth('post', '/parents/5/activation-invitation');
    expect(issued.status).toBe(201);
    expect(invitations[0].codeHash).not.toBe(issued.body.code.replaceAll('-', ''));
    expect((await request(app).post('/auth/registration-status').send({
      phone: '+254700000000', invitationCode: issued.body.code,
    })).status).toBe(403);
    expect((await request(app).post('/auth/registration-status').send({
      phone: parentPhone, invitationCode: issued.body.code,
    })).body).toMatchObject({ found: true, firstName: 'Test' });
    const activation = { phone: parentPhone, invitationCode: issued.body.code, newPassword: 'synthetic-password' };
    const activated = await request(app).post('/auth/complete-registration').send(activation);
    expect(activated.status).toBe(200);
    expect(jwt.verify(activated.body.token, secret)).toMatchObject({ id: 5, role: 'parent', authVersion: 1 });
    expect(accounts.get(5).mustSetPassword).toBe(false);
    expect(accounts.get(5)).toMatchObject({ authVersion: 1, expoPushToken: null, fcmPushToken: null });
    expect((await request(app).get('/messages/conversations').set('Authorization', `Bearer ${oldToken}`)).status).toBe(401);
    expect((await request(app).get('/messages/conversations').set('Authorization', `Bearer ${activated.body.token}`)).status).toBe(200);
    expect(accounts.get(5).save).toHaveBeenCalledWith({ transaction });
    expect(invitations[0].update).toHaveBeenCalledWith({ consumedAt: expect.any(Date) }, { transaction });
    expect((await request(app).post('/auth/complete-registration').send(activation)).status).toBe(403);
    expect(accounts.get(5).save).toHaveBeenCalledTimes(1);
  });
  test.each(['expired', 'regenerated', 'revoked membership'])('rejects a %s invitation without account writes', async reason => {
    const issued = await auth('post', '/parents/5/activation-invitation');
    if (reason === 'expired') invitations[0].expiresAt = new Date(Date.now() - 1);
    if (reason === 'regenerated') await auth('post', '/parents/5/activation-invitation');
    if (reason === 'revoked membership') membershipActive = false;
    expect((await request(app).post('/auth/complete-registration').send({
      phone: parentPhone, invitationCode: issued.body.code, newPassword: 'synthetic-password',
    })).status).toBe(403);
    expect(accounts.get(5).save).not.toHaveBeenCalled();
  });
});

describe('relationship-scoped server-owned chat', () => {
  beforeEach(() => { accounts.get(5).mustSetPassword = false; });
  test('registering a shared device removes its push destination from the previous account transactionally', async () => {
    const res = await auth('put', '/auth/push-token', 5).send({ pushToken: 'synthetic-device-token' });
    expect(res.status).toBe(200);
    expect(models.User.update).toHaveBeenCalledWith({ expoPushToken: null }, {
      where: { expoPushToken: 'synthetic-device-token', id: { [Op.ne]: 5 } }, transaction,
    });
    expect(accounts.get(5).save).toHaveBeenCalledWith({ transaction });
    expect(models.sequelize.query).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'),
      expect.objectContaining({ transaction }));
  });
  test('parents can find their active replacement driver without a current route assignment', async () => {
    models.Student.findAll.mockResolvedValue([{ id: 21, schoolId: 4, parentId: 5 }]);
    models.RouteStudent.findAll.mockResolvedValue([]);
    models.Trip.findAll.mockResolvedValue([{
      id: 40, route: { id: 20, schoolId: 4, name: 'Changed route' }, driver: accounts.get(9),
      plan: { schoolId: 4, routeName: 'Original route', stops: [{ studentId: 21, parentId: 5 }] },
    }]);
    const res = await auth('get', '/messages/my-drivers', 5);
    expect(res.status).toBe(200);
    expect(res.body.drivers).toEqual([expect.objectContaining({ id: 9, routeName: 'Original route' })]);
  });
  test('school broadcasts use the frozen trip parents instead of a replacement current roster', async () => {
    models.Trip.findAll.mockResolvedValue([{
      id: 40, status: 'in_progress',
      route: { students: [{ id: 22, parentId: 8, parent: accounts.get(8) }] },
      plan: { schoolId: 4, stops: [{ studentId: 21, parentId: 5 }] },
    }]);
    models.Student.findAll.mockResolvedValue([{ id: 21, parentId: 5, schoolId: 4, parent: accounts.get(5) }]);
    const res = await auth('post', '/messages/trip-notification').send({ tripIds: [40], content: 'Synthetic notice' });
    expect(res.status).toBe(201);
    expect(messages.map(message => message.receiverId)).toEqual([5]);
    expect(enqueueMessageNotification).toHaveBeenCalledWith(messages[0], transaction);
  });
  test.each([7, 8, 9])('denies unrelated parent recipient %s before persistence', async receiverId => {
    const res = await auth('post', '/messages', 5).send({ receiverId, content: 'Synthetic message' });
    expect(res.status).toBe(404);
    expect(models.Message.create).not.toHaveBeenCalled();
  });
  test('allows an assigned driver and uses school membership rather than the parent primary school', async () => {
    const res = await auth('post', '/messages', 5).send({ receiverId: 3, content: 'Synthetic message' });
    expect(res.status).toBe(201);
    expect(messages[0]).toMatchObject({ schoolId: 4, senderId: 5, receiverId: 3, messageType: 'text' });
    expect(enqueueMessageNotification).toHaveBeenCalledWith(messages[0], transaction);
  });
  test.each(['alert', 'system', 'absence', 'arrival'])('does not allow parents to manufacture %s notifications', async messageType => {
    expect((await auth('post', '/messages', 5).send({ receiverId: 3, content: 'Synthetic', messageType })).status).toBe(400);
    expect(models.Message.create).not.toHaveBeenCalled();
  });
  test('rejects a foreign trip even when the recipient is otherwise permitted', async () => {
    getAccessibleTrip.mockResolvedValue(null);
    expect((await auth('post', '/messages', 5).send({ receiverId: 3, content: 'Synthetic', tripId: 999 })).status).toBe(404);
    expect(models.Message.create).not.toHaveBeenCalled();
  });
  test('a timeout retry returns the original message and queues delivery only once', async () => {
    const body = { receiverId: 3, content: 'Synthetic', clientMessageId: 'synthetic-retry-001' };
    expect((await auth('post', '/messages', 5).send(body)).status).toBe(201);
    const retry = await auth('post', '/messages', 5).send(body);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ duplicate: true, message: { id: 1 } });
    expect(models.Message.create).toHaveBeenCalledTimes(1);
    expect(enqueueMessageNotification).toHaveBeenCalledTimes(1);
    expect((await auth('post', '/messages', 5).send({ ...body, content: 'Different' })).status).toBe(409);
  });
  test('membership revocation blocks new messages but does not grant an alternate-school fallback', async () => {
    membershipActive = false;
    expect((await auth('post', '/messages', 5).send({ receiverId: 3, content: 'Synthetic' })).status).toBe(404);
  });
  test('route contact directories reject parents and unassigned drivers', async () => {
    expect((await auth('get', '/messages/route-parents/20', 5)).status).toBe(403);
    expect((await auth('get', '/messages/route-parents/20', 9)).status).toBe(404);
    expect((await auth('get', '/messages/route-parents/20', 3)).status).toBe(200);
  });
  test('latest-message pagination marks only the returned received messages read', async () => {
    const latest = Array.from({ length: 51 }, (_, index) => row({ id: 60 - index, senderId: 3, receiverId: 5, isRead: false }));
    models.Message.findAll.mockResolvedValue(latest);
    const res = await auth('get', '/messages/thread/3', 5);
    expect(res.status).toBe(200);
    expect(res.body.messages.map(message => message.id)).toEqual(Array.from({ length: 50 }, (_, index) => index + 11));
    expect(res.body.hasMore).toBe(true);
    expect(models.Message.findAll).toHaveBeenCalledWith(expect.objectContaining({ order: [['id', 'DESC']], limit: 51 }));
    expect(models.Message.update.mock.calls[0][1].where.id[Op.in]).toEqual(res.body.messages.map(message => message.id));
  });
});
