const mockSend = jest.fn();
jest.mock('../models', () => ({ User: { findByPk: jest.fn(), update: jest.fn() } }));
jest.mock('firebase-admin/app', () => ({
  getApps: () => [{}], initializeApp: jest.fn(), cert: jest.fn(), applicationDefault: jest.fn(),
}));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: () => ({ send: mockSend }) }));
const { User } = require('../models');
const { deliverOutboxPush } = require('../services/push');
const originalFetch = global.fetch;
const reply = data => ({ ok: true, json: async () => ({ data }) });

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
  User.findByPk.mockResolvedValue({ id: 1, expoPushToken: 'ExpoPushToken[test]', fcmPushToken: null });
  User.update.mockResolvedValue([1]);
  mockSend.mockResolvedValue('fcm-message');
});
afterAll(() => { global.fetch = originalFetch; });

test('submits an Expo ticket once, then checks its receipt without resending', async () => {
  fetch.mockResolvedValueOnce(reply({ status: 'ok', id: 'ticket' }))
    .mockResolvedValueOnce(reply({ ticket: { status: 'ok' } }));
  const first = await deliverOutboxPush(1, 'Title', 'Body', {});
  expect(first.expo).toEqual({ status: 'pending_receipt', ticketId: 'ticket' });
  const second = await deliverOutboxPush(1, 'Title', 'Body', {}, first);
  expect(second.expo.status).toBe('accepted');
  expect(fetch.mock.calls.map(call => call[0])).toEqual([
    'https://exp.host/--/api/v2/push/send', 'https://exp.host/--/api/v2/push/getReceipts',
  ]);
});

test('HTTP failures remain retryable and visible', async () => {
  fetch.mockResolvedValue({ ok: false, status: 429 });
  expect((await deliverOutboxPush(1, 'Title', 'Body', {})).expo)
    .toMatchObject({ status: 'retrying', error: 'EXPO_HTTP_429' });
});

test('invalid registration clears only the token that failed', async () => {
  fetch.mockResolvedValue(reply({ status: 'error', details: { error: 'DeviceNotRegistered' } }));
  expect((await deliverOutboxPush(1, 'Title', 'Body', {})).expo.status).toBe('unregistered');
  expect(User.update).toHaveBeenCalledWith(
    { expoPushToken: null }, { where: { id: 1, expoPushToken: 'ExpoPushToken[test]' } },
  );
});

test('FCM acceptance is retained while an Expo submission is retried', async () => {
  User.findByPk.mockResolvedValue({ id: 1, expoPushToken: 'ExpoPushToken[test]', fcmPushToken: 'fcm-test' });
  fetch.mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(reply({ status: 'ok', id: 'ticket' }));
  const first = await deliverOutboxPush(1, 'Title', 'Body', { tripId: 1 });
  const second = await deliverOutboxPush(1, 'Title', 'Body', { tripId: 1 }, first);
  expect(second.fcm.status).toBe('accepted');
  expect(mockSend).toHaveBeenCalledTimes(1);
});

test('missing devices remain unregistered over repeated attempts', async () => {
  User.findByPk.mockResolvedValue({ id: 1 });
  const first = await deliverOutboxPush(1, 'Title', 'Body', {});
  expect((await deliverOutboxPush(1, 'Title', 'Body', {}, first)).device.status).toBe('unregistered');
});
