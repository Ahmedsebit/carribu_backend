const { Op } = require('sequelize');
jest.mock('../models', () => ({
  sequelize: { transaction: jest.fn(), query: jest.fn() },
  NotificationOutbox: { create: jest.fn(), findOne: jest.fn(), findAll: jest.fn() },
  Message: { create: jest.fn(), findByPk: jest.fn() },
  User: { findByPk: jest.fn() }, Student: { findOne: jest.fn(), findAll: jest.fn() },
  Trip: { findAll: jest.fn(), findByPk: jest.fn() }, TripLog: { findAll: jest.fn() },
  Route: { findOne: jest.fn() }, School: {},
  ParentSchool: { findOne: jest.fn(), findAll: jest.fn() },
}));
jest.mock('../socket', () => ({ emitUser: jest.fn(), notifyUser: jest.fn(), notifyTrip: jest.fn(), PUSH_TITLES: {} }));
jest.mock('../services/push', () => ({ deliverOutboxPush: jest.fn() }));
jest.mock('../services/tripWorkflow', () => ({ lockSchool: jest.fn() }));
jest.mock('../services/tripAccess', () => ({ getAccessibleTrip: jest.fn() }));
const models = require('../models');
const socket = require('../socket');
const { deliverOutboxPush } = require('../services/push');
const { getAccessibleTrip } = require('../services/tripAccess');
const outbox = require('../services/notificationOutbox');
const reminders = require('../services/tripReminders');
const { buildTripPlan } = require('../services/tripPlan');
const row = data => {
  const value = { ...data };
  value.update = jest.fn(async updates => Object.assign(value, updates));
  value.toJSON = () => ({ ...value });
  return value;
};
let transaction, queue, messages, trip, child, parent, sender, now;
beforeEach(() => {
  jest.resetAllMocks();
  transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' }, afterCommit: jest.fn() };
  models.sequelize.transaction.mockImplementation(async callback => {
    const result = await callback(transaction);
    for (const [commit] of transaction.afterCommit.mock.calls) await commit();
    transaction.afterCommit.mockClear();
    return result;
  });
  queue = []; messages = [];
  parent = { id: 5, role: 'parent', isActive: true, schoolId: 99 };
  sender = { id: 3, role: 'driver', isActive: true, schoolId: 4, firstName: 'Test', lastName: 'Driver' };
  child = { id: 20, schoolId: 4, parentId: 5, isActive: true, firstName: 'Test', lastName: 'Child', parent };
  const route = row({ id: 9, schoolId: 4, name: 'Test route', students: [child] });
  trip = row({ id: 30, routeId: 9, driverId: 3, status: 'scheduled', type: 'morning_pickup',
    scheduledDate: '2099-11-20', scheduledTime: '08:00:00', route });
  trip.plan = buildTripPlan(trip, route);
  now = reminders.tripStartMs(trip) + 5 * 60000;
  models.User.findByPk.mockImplementation(async id => id === 5 ? parent : sender);
  models.Student.findOne.mockResolvedValue(child);
  models.Student.findAll.mockResolvedValue([child]);
  models.ParentSchool.findOne.mockResolvedValue({ id: 1 });
  models.ParentSchool.findAll.mockResolvedValue([{ parentId: 5 }]);
  models.Route.findOne.mockResolvedValue(route);
  models.Trip.findAll.mockResolvedValue([trip]);
  models.Trip.findByPk.mockResolvedValue(trip);
  getAccessibleTrip.mockResolvedValue({ trip });
  models.TripLog.findAll.mockResolvedValue([]);
  models.Message.create.mockImplementation(async data => {
    const message = row({ id: messages.length + 1, createdAt: new Date(), ...data });
    messages.push(message); return message;
  });
  models.Message.findByPk.mockImplementation(async id => messages.find(message => message.id === id));
  models.NotificationOutbox.create.mockImplementation(async data => {
    const queued = row({ id: queue.length + 1, attempts: 0, createdAt: new Date(), providerResults: {},
      status: 'pending', ...data });
    queue.push(queued); return queued;
  });
  models.NotificationOutbox.findOne.mockImplementation(async ({ where }) => queue.find(item => item.eventKey === where.eventKey));
  models.NotificationOutbox.findAll.mockImplementation(async () =>
    queue.filter(item => ['pending', 'retrying', 'unregistered', 'pending_receipt'].includes(item.status)));
  deliverOutboxPush.mockResolvedValue({ expo: { status: 'accepted' } });
});

test('message persistence queues stable IDs in the same transaction and delivers to both accounts once', async () => {
  const message = await models.Message.create({ schoolId: 4, senderId: 3, receiverId: 5, content: 'Synthetic', messageType: 'text' });
  await outbox.enqueueMessageNotification(message, transaction);
  expect(models.NotificationOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
    tripId: null, messageId: 1, eventKey: 'message:1',
    payload: expect.objectContaining({ id: 1, eventId: 'message:1', senderId: 3, receiverId: 5 }),
  }), { transaction });
  expect(await outbox.processNotificationOutbox()).toBe(1);
  expect(socket.emitUser.mock.calls.map(call => call[0])).toEqual([5, 3]);
  expect(queue[0].status).toBe('accepted');
  expect(await outbox.processNotificationOutbox()).toBe(0);
});

test('a transient provider failure keeps the persisted message and retries the same event', async () => {
  const message = await models.Message.create({ schoolId: 4, senderId: 3, receiverId: 5, content: 'Synthetic', messageType: 'text' });
  await outbox.enqueueMessageNotification(message, transaction);
  deliverOutboxPush.mockResolvedValueOnce({ expo: { status: 'retrying', error: 'UNAVAILABLE' } });
  await outbox.processNotificationOutbox();
  expect(queue[0].status).toBe('retrying');
  await outbox.processNotificationOutbox();
  expect(queue[0]).toMatchObject({ status: 'accepted', attempts: 2, eventKey: 'message:1' });
  expect(messages).toHaveLength(1);
});

test.each(['deleted recipient copy', 'revoked school', 'changed driver assignment'])('cancels queued chat after %s', async reason => {
  const message = await models.Message.create({ schoolId: 4, senderId: 3, receiverId: 5, content: 'Synthetic', messageType: 'text' });
  await outbox.enqueueMessageNotification(message, transaction);
  if (reason === 'deleted recipient copy') message.receiverDeletedAt = new Date();
  if (reason === 'revoked school') models.ParentSchool.findOne.mockResolvedValue(null);
  if (reason === 'changed driver assignment') {
    models.Route.findOne.mockResolvedValue(null); models.Trip.findAll.mockResolvedValue([]);
  }
  await outbox.processNotificationOutbox();
  expect(queue[0].status).toBe('cancelled');
  expect(socket.emitUser).not.toHaveBeenCalled();
  expect(deliverOutboxPush).not.toHaveBeenCalled();
});

test('deleting the sender copy suppresses echoes but still delivers the recipient copy', async () => {
  const message = await models.Message.create({ schoolId: 4, senderId: 3, receiverId: 5, content: 'Synthetic',
    messageType: 'text', senderDeletedAt: new Date() });
  await outbox.enqueueMessageNotification(message, transaction);
  await outbox.processNotificationOutbox();
  expect(socket.emitUser.mock.calls.map(call => call[0])).toEqual([5]);
  expect(deliverOutboxPush).toHaveBeenCalledTimes(1);
});

test('delay status, parent alert and outbox event commit together without locking nullable joined tables', async () => {
  expect(await reminders.checkDelayedTrips(now)).toEqual([30]);
  expect(trip.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'delayed' }), { transaction });
  expect(models.Trip.findByPk).toHaveBeenCalledWith(30, expect.objectContaining({
    lock: { level: 'UPDATE', of: models.Trip }, transaction,
  }));
  expect(models.Message.create).toHaveBeenCalledWith(expect.objectContaining({ receiverId: 5, messageType: 'alert' }), { transaction });
  expect(models.NotificationOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
    event: 'trip-delayed', eventKey: 'trip:30:delayed:20',
  }), { transaction });
  expect(await reminders.checkDelayedTrips(now)).toEqual([]);
  expect(queue).toHaveLength(1);
});

test('queue failure aborts disruption processing before post-commit driver notification', async () => {
  models.NotificationOutbox.create.mockRejectedValue(new Error('Synthetic persistence failure'));
  await expect(reminders.checkDelayedTrips(now)).rejects.toThrow('Synthetic persistence failure');
  expect(socket.notifyUser).not.toHaveBeenCalled();
});

test('resolved delays are not pushed; missed journeys generate distinct parent events', async () => {
  await reminders.checkDelayedTrips(now);
  now = reminders.tripStartMs(trip) + (reminders.START_WINDOW_MINUTES + 1) * 60000;
  expect(await reminders.checkMissedTrips(now)).toEqual([30]);
  await outbox.processNotificationOutbox();
  expect(queue.map(item => item.status)).toEqual(['cancelled', 'accepted']);
  expect(socket.emitUser).toHaveBeenCalledWith(5, 'trip-missed', expect.objectContaining({ status: 'missed' }));
});

test('a revoked parent role cannot receive a queued trip notification', async () => {
  await reminders.checkDelayedTrips(now);
  parent.role = 'driver';
  await outbox.processNotificationOutbox();
  expect(queue[0]).toMatchObject({ status: 'cancelled', lastError: 'PARENT_ACCOUNT_INACTIVE' });
  expect(deliverOutboxPush).not.toHaveBeenCalled();
});
test('removing current trip access suppresses a pending disruption push', async () => {
  await reminders.checkDelayedTrips(now);
  getAccessibleTrip.mockResolvedValue(null);
  await outbox.processNotificationOutbox();
  expect(queue[0]).toMatchObject({ status: 'cancelled', lastError: 'TRIP_ACCESS_INACTIVE' });
  expect(deliverOutboxPush).not.toHaveBeenCalled();
});
test('pending activation prevents both queued chat and trip delivery to an old device', async () => {
  await reminders.checkDelayedTrips(now);
  const message = await models.Message.create({ schoolId: 4, senderId: 3, receiverId: 5, content: 'Synthetic', messageType: 'text' });
  await outbox.enqueueMessageNotification(message, transaction);
  parent.mustSetPassword = true;
  await outbox.processNotificationOutbox();
  expect(queue.map(item => item.status)).toEqual(['cancelled', 'cancelled']);
  expect(socket.emitUser).not.toHaveBeenCalled();
  expect(deliverOutboxPush).not.toHaveBeenCalled();
});

test('same-day legacy disruptions snapshot eligible students, but old unknown rosters are never invented', async () => {
  trip.plan = null;
  await reminders.checkDelayedTrips(now);
  expect(trip.plan.stops.map(stop => stop.studentId)).toEqual([20]);
  expect(queue).toHaveLength(1);
  trip.plan = null; trip.status = 'scheduled'; queue.length = 0;
  now += 86400000;
  await reminders.checkMissedTrips(now);
  expect(trip.plan).toBeNull();
  expect(queue).toHaveLength(0);
});

test('unstarted plans refresh changed guardians before freezing disruption recipients', async () => {
  trip.plan.stops[0].parentId = 8;
  await reminders.checkDelayedTrips(now);
  expect(trip.plan.stops[0].parentId).toBe(5);
  expect(queue[0].receiverId).toBe(5);
});
test('disruption refresh cannot relabel a foreign-school snapshot as an authorised plan', async () => {
  trip.plan.schoolId = 99;
  await reminders.checkDelayedTrips(now);
  expect(trip.plan.schoolId).toBe(99);
  expect(queue).toHaveLength(0);
});

test('the school-local calendar includes midnight trips before the UTC day changes', () => {
  const offset = Number(process.env.SCHOOL_UTC_OFFSET_HOURS || 3) * 3600000;
  expect(reminders.schoolDate(Date.parse('2099-11-21T00:05:00Z') - offset)).toBe('2099-11-21');
});
