jest.mock('../models', () => ({ User: { findByPk: jest.fn() } }));
jest.mock('firebase-admin/app', () => ({
  applicationDefault: jest.fn(), cert: jest.fn(), getApps: jest.fn(), initializeApp: jest.fn(),
}));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));
const { User } = require('../models');
const { getApps } = require('firebase-admin/app');
const { sendPushToUser, deliverOutboxPush } = require('../services/push');
let originalFetch;
beforeAll(() => { originalFetch = global.fetch; });
afterAll(() => { global.fetch = originalFetch; });
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn(async () => { throw new Error('Network access is forbidden in this test.'); });
});
test('pending parents cannot receive direct or outbox push through old device registrations', async () => {
  User.findByPk.mockResolvedValue({
    id: 5, role: 'parent', isActive: true, mustSetPassword: true,
    expoPushToken: 'ExponentPushToken[synthetic]', fcmPushToken: 'synthetic-fcm',
  });
  await sendPushToUser(5, 'Synthetic title', 'Synthetic message');
  expect(await deliverOutboxPush(5, 'Synthetic title', 'Synthetic message', {}))
    .toEqual({ account: { status: 'failed', error: 'ACCOUNT_NOT_ACTIVATED' } });
  expect(global.fetch).not.toHaveBeenCalled();
  expect(getApps).not.toHaveBeenCalled();
});
