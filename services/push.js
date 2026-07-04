const { User } = require('../models');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

function isExpoToken(token) {
  return typeof token === 'string' && (token.startsWith('ExponentPushToken') || token.startsWith('ExpoPushToken'));
}

/**
 * Send an Expo push notification to a single user (best-effort).
 * Looks up the user's stored expoPushToken and delivers a tray notification
 * via the Expo push service. Failures are swallowed so they never break the
 * request that triggered the notification.
 */
async function sendPushToUser(userId, title, body, data = {}) {
  try {
    const user = await User.findByPk(userId, { attributes: ['id', 'expoPushToken'] });
    const token = user && user.expoPushToken;
    if (!isExpoToken(token)) return;

    const message = {
      to: token,
      title,
      body,
      sound: 'default',
      priority: 'high',
      channelId: 'default',
      data,
    };

    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(message),
    });
    const json = await res.json().catch(() => null);

    // Clear tokens Expo reports as no longer registered so we stop retrying.
    const ticket = json && json.data;
    if (ticket && ticket.status === 'error' && ticket.details && ticket.details.error === 'DeviceNotRegistered') {
      await user.update({ expoPushToken: null });
    }
  } catch (err) {
    console.warn('Push send failed:', err.message);
  }
}

module.exports = { sendPushToUser, isExpoToken };
