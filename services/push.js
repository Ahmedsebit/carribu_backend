const { User } = require('../models');
const {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
let firebaseMessaging;
let firebaseInitializationAttempted = false;

function isExpoToken(token) {
  return typeof token === 'string' && (token.startsWith('ExponentPushToken') || token.startsWith('ExpoPushToken'));
}

function getFirebaseMessaging() {
  if (firebaseInitializationAttempted) return firebaseMessaging;
  firebaseInitializationAttempted = true;

  try {
    if (getApps().length === 0) {
      const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      if (serviceAccountJson) {
        const serviceAccount = JSON.parse(serviceAccountJson);
        initializeApp({ credential: cert(serviceAccount) });
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        initializeApp({ credential: applicationDefault() });
      } else {
        return undefined;
      }
    }
    firebaseMessaging = getMessaging();
    return firebaseMessaging;
  } catch (err) {
    console.warn('FCM initialization failed:', err.message);
    return undefined;
  }
}

async function sendExpoPush(user, title, body, data) {
  if (!isExpoToken(user.expoPushToken)) return;
  const message = {
    to: user.expoPushToken,
    title,
    body,
    sound: 'default',
    priority: 'high',
    channelId: 'default',
    data,
  };

  try {
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
    console.warn('Expo push send failed:', err.message);
  }
}

function toFcmData(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : JSON.stringify(value),
  ]));
}

async function sendFcmPush(user, title, body, data) {
  if (!user.fcmPushToken) return;
  const messaging = getFirebaseMessaging();
  if (!messaging) return;

  try {
    await messaging.send({
      token: user.fcmPushToken,
      notification: { title, body },
      data: toFcmData(data),
      android: {
        priority: 'high',
        notification: { channelId: 'carribu_updates', sound: 'default' },
      },
    });
  } catch (err) {
    const invalidTokenCodes = [
      'messaging/invalid-registration-token',
      'messaging/registration-token-not-registered',
    ];
    if (invalidTokenCodes.includes(err.code)) {
      await user.update({ fcmPushToken: null });
    }
    console.warn('FCM push send failed:', err.message);
  }
}

/**
 * Delivers best-effort tray notifications to all providers registered by a
 * user. Provider failures never break the request that triggered the push.
 */
async function sendPushToUser(userId, title, body, data = {}) {
  try {
    const user = await User.findByPk(userId, {
      attributes: ['id', 'expoPushToken', 'fcmPushToken'],
    });
    if (!user) return;
    await Promise.all([
      sendExpoPush(user, title, body, data),
      sendFcmPush(user, title, body, data),
    ]);
  } catch (err) {
    console.warn('Push lookup failed:', err.message);
  }
}

module.exports = { sendPushToUser, isExpoToken };
