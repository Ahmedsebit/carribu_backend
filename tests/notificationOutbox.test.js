jest.mock('../services/push', () => ({ sendPushToUser: jest.fn(), deliverOutboxPush: jest.fn() }));
const { setupTestDB, getTestData } = require('./setup');
const { sequelize, Trip, TripLog, Message, NotificationOutbox } = require('../models');
const { startTrip } = require('../services/tripWorkflow');
const { enqueueNotification, processNotificationOutbox, deliveryState } = require('../services/notificationOutbox');
const { deliverOutboxPush } = require('../services/push');

let data, actor, trip;
beforeAll(async () => {
  if (!/^carribu_workflow_[a-z0-9_]+$/.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1') {
    throw new Error('Outbox integration tests require an isolated local carribu_workflow_* database.');
  }
  data = await setupTestDB();
  actor = { id: data.driver.id, schoolId: data.school.id, role: 'driver' };
});
afterAll(async () => sequelize.close());
beforeEach(async () => {
  jest.restoreAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  deliverOutboxPush.mockReset();
  deliverOutboxPush.mockResolvedValue({ fcm: { status: 'accepted' } });
  await NotificationOutbox.destroy({ where: {} });
  await Message.destroy({ where: {} });
  await TripLog.destroy({ where: {} });
  await Trip.destroy({ where: {} });
  await data.student1.update({ parentId: data.parent.id });
  trip = await Trip.create({
    routeId: data.route.id, driverId: data.driver.id, vehicleId: data.vehicle.id,
    type: 'morning_pickup', scheduledDate: '2026-10-30',
  });
  await startTrip(trip.id, actor);
  await trip.reload();
});

test('parallel workers claim each event only once', async () => {
  await Promise.all([processNotificationOutbox(), processNotificationOutbox()]);
  expect(deliverOutboxPush).toHaveBeenCalledTimes(2);
  expect(await NotificationOutbox.count({ where: { status: 'accepted' } })).toBe(2);
});

test('failed delivery is observable and retries without duplicating saved messages', async () => {
  deliverOutboxPush.mockRejectedValue(new Error('provider unavailable'));
  const messages = await Message.count();
  await processNotificationOutbox();
  expect(await NotificationOutbox.count({ where: { status: 'retrying' } })).toBe(2);
  deliverOutboxPush.mockResolvedValue({ fcm: { status: 'accepted' } });
  await NotificationOutbox.update({ nextAttemptAt: new Date(0) }, { where: {} });
  await processNotificationOutbox();
  expect(await NotificationOutbox.count({ where: { status: 'accepted' } })).toBe(2);
  expect(await Message.count()).toBe(messages);
  expect((await NotificationOutbox.findOne()).attempts).toBe(2);
});

test('provider acceptance and Expo receipt waiting are distinct diagnostics', async () => {
  deliverOutboxPush.mockResolvedValue({ expo: { status: 'pending_receipt', ticketId: 'ticket' } });
  await processNotificationOutbox();
  expect(await NotificationOutbox.count({ where: { status: 'pending_receipt' } })).toBe(2);
  deliverOutboxPush.mockResolvedValue({ expo: { status: 'accepted' } });
  await NotificationOutbox.update({ nextAttemptAt: new Date(0) }, { where: {} });
  await processNotificationOutbox();
  expect(await NotificationOutbox.count({ where: { status: 'accepted' } })).toBe(2);
});

test('expired worker leases are recoverable after a crash', async () => {
  await NotificationOutbox.update({
    status: 'processing', lockedUntil: new Date(0), nextAttemptAt: new Date(0),
  }, { where: {} });
  await processNotificationOutbox();
  expect(await NotificationOutbox.count({ where: { status: 'accepted' } })).toBe(2);
});

test('a stale queued proximity warning is cancelled rather than delivered late', async () => {
  await sequelize.transaction(async transaction => enqueueNotification({
    trip, student: trip.plan.stops[0], event: 'driver-approaching', key: 'near:pickup',
    message: 'Bus near pickup', extra: { phase: 'pickup', recordedAt: new Date(Date.now() - 180000).toISOString() },
  }, transaction));
  await processNotificationOutbox();
  const stale = await NotificationOutbox.findOne({ where: { event: 'driver-approaching' } });
  expect(stale.status).toBe('cancelled');
  expect(stale.lastError).toBe('STALE_PROXIMITY_ALERT');
  expect(deliverOutboxPush.mock.calls.every(call => call[3].event !== 'driver-approaching')).toBe(true);
});

test('enqueue rollback also removes its saved in-app message', async () => {
  const before = await Message.count();
  await expect(sequelize.transaction(async transaction => {
    await enqueueNotification({
      trip, student: trip.plan.stops[0], event: 'student-dropped-off', key: 'rollback', message: 'Test',
    }, transaction);
    throw new Error('rollback');
  })).rejects.toThrow('rollback');
  expect(await Message.count()).toBe(before);
});

test('missing devices and exhausted retries do not look like successful delivery', async () => {
  expect(deliveryState({ device: { status: 'unregistered' } })).toBe('unregistered');
  deliverOutboxPush.mockResolvedValue({ device: { status: 'unregistered', error: 'NO_REGISTERED_DEVICE' } });
  await NotificationOutbox.update({ attempts: 11 }, { where: {} });
  await processNotificationOutbox();
  expect(await NotificationOutbox.count({ where: { status: 'failed' } })).toBe(2);
});

test('a guardian change cancels pending delivery to the former parent', async () => {
  await data.student1.update({ parentId: data.parent2.id });
  await processNotificationOutbox();
  const cancelled = await NotificationOutbox.findOne({ where: { receiverId: data.parent.id } });
  expect(cancelled.status).toBe('cancelled');
  expect(cancelled.lastError).toBe('RECIPIENT_ACCESS_INACTIVE');
  expect(deliverOutboxPush).toHaveBeenCalledTimes(1);
});

test('new events for a former guardian are diagnosed without creating an unauthorized in-app message', async () => {
  await data.student1.update({ parentId: data.parent2.id });
  const before = await Message.count();
  const row = await sequelize.transaction(transaction => enqueueNotification({
    trip, student: trip.plan.stops[0], event: 'student-dropped-off', key: 'guardian-change', message: 'Test',
  }, transaction));
  expect(row.status).toBe('cancelled');
  expect(row.messageId).toBeNull();
  expect(await Message.count()).toBe(before);
});

test('expired events are diagnosed before sending another obsolete notification', async () => {
  await NotificationOutbox.update({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }, { where: {} });
  await processNotificationOutbox();
  expect(deliverOutboxPush).not.toHaveBeenCalled();
  expect(await NotificationOutbox.count({ where: { status: 'failed', lastError: 'NOTIFICATION_EXPIRED' } })).toBe(2);
});
