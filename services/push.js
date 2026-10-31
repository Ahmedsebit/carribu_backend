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

async function expoRequest(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`EXPO_HTTP_${response.status}`);
    const json = await response.json();
    if (!json.data) throw new Error('EXPO_INVALID_RESPONSE');
    return json.data;
  } finally { clearTimeout(timer); }
}

async function deliverOutboxPush(userId, title, body, data, previous = {}) {
  const user = await User.findByPk(userId, { attributes: ['id', 'expoPushToken', 'fcmPushToken'] });
  if (!user) return { account: { status: 'failed', error: 'USER_NOT_FOUND' } };
  const results = { ...previous };
  if (results.expo?.status === 'pending_receipt') {
    try {
      const receipts = await expoRequest('getReceipts', { ids: [results.expo.ticketId] });
      const receipt = receipts[results.expo.ticketId];
      if (receipt?.status === 'ok') results.expo = { status: 'accepted' };
      else if (receipt?.status === 'error') {
        results.expo = { status: 'retrying', error: receipt.details?.error || 'EXPO_RECEIPT_ERROR' };
        if (receipt.details?.error === 'DeviceNotRegistered') {
          await User.update({ expoPushToken: null }, { where: { id: user.id, expoPushToken: user.expoPushToken } });
          results.expo.status = 'unregistered';
        }
      }
    } catch (error) {
      results.expo = { ...results.expo, error: 'EXPO_RECEIPT_UNAVAILABLE' };
    }
  } else if (isExpoToken(user.expoPushToken) && results.expo?.status !== 'accepted') {
    try {
      const ticket = await expoRequest('send', {
        to: user.expoPushToken, title, body, data, sound: 'default', priority: 'high', channelId: 'default',
      });
      if (ticket.status === 'ok' && ticket.id) {
        results.expo = { status: 'pending_receipt', ticketId: ticket.id };
      } else {
        const code = ticket.details?.error || 'EXPO_TICKET_ERROR';
        results.expo = { status: 'retrying', error: code };
        if (code === 'DeviceNotRegistered') {
          await User.update({ expoPushToken: null }, { where: { id: user.id, expoPushToken: user.expoPushToken } });
          results.expo.status = 'unregistered';
        }
      }
    } catch (error) {
      results.expo = { status: 'retrying', error: /^EXPO_HTTP_\d+$/.test(error.message) ? error.message : 'EXPO_UNAVAILABLE' };
    }
  }
  if (user.fcmPushToken && results.fcm?.status !== 'accepted') {
    const messaging = getFirebaseMessaging();
    if (!messaging) results.fcm = { status: 'retrying', error: 'FCM_NOT_CONFIGURED' };
    else {
      try {
        await messaging.send({
          token: user.fcmPushToken, notification: { title, body }, data: toFcmData(data),
          android: { priority: 'high', notification: { channelId: 'carribu_updates', sound: 'default' } },
        });
        results.fcm = { status: 'accepted' };
      } catch (error) {
        const code = error.code || 'FCM_UNAVAILABLE';
        results.fcm = { status: 'retrying', error: code };
        if (['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(code)) {
          await User.update({ fcmPushToken: null }, { where: { id: user.id, fcmPushToken: user.fcmPushToken } });
          results.fcm.status = 'unregistered';
        }
      }
    }
  }
  delete results.device;
  if (!Object.keys(results).length) results.device = { status: 'unregistered', error: 'NO_REGISTERED_DEVICE' };
  return results;
}

module.exports.deliverOutboxPush = deliverOutboxPush;
