const { Op } = require('sequelize');
const { sequelize, NotificationOutbox, Message, Trip, TripLog, Student } = require('../models');
const { getTripState, locationFreshness } = require('./tripPlan');
const { emitUser, PUSH_TITLES } = require('../socket');
const { deliverOutboxPush } = require('./push');
const { getActiveParentIdsForSchool } = require('../utils/parentSchoolAccess');

let timer = null;
let running = null;

async function enqueueNotification({ trip, student, event, key, message, extra = {} }, transaction) {
  if (!student.parentId) return null;
  const eventKey = `trip:${trip.id}:${key}:${student.studentId}`;
  const existing = await NotificationOutbox.findOne({ where: { eventKey }, transaction });
  if (existing) return existing;
  const active = await getActiveParentIdsForSchool([student.parentId], trip.plan.schoolId, transaction);
  const authorized = await Student.findOne({
    where: { id: student.studentId, parentId: student.parentId, schoolId: trip.plan.schoolId, isActive: true },
    transaction, lock: transaction.LOCK.SHARE,
  });
  const canNotify = active.has(student.parentId) && !!authorized;
  const saved = canNotify ? await Message.create({
    schoolId: trip.plan.schoolId, tripId: trip.id, senderId: trip.driverId,
    receiverId: student.parentId, content: message, messageType: 'system',
  }, { transaction }) : null;
  const queued = await NotificationOutbox.create({
    eventKey, schoolId: trip.plan.schoolId, tripId: trip.id, receiverId: student.parentId,
    messageId: saved?.id || null, event,
    status: canNotify ? 'pending' : 'cancelled',
    lastError: canNotify ? null : 'RECIPIENT_ACCESS_INACTIVE',
    payload: {
      eventId: eventKey, tripId: trip.id, studentId: student.studentId,
      studentName: student.studentName, message, ...extra,
      occurredAt: new Date().toISOString(),
    },
  }, { transaction });
  transaction.afterCommit(wakeNotificationWorker);
  return queued;
}

function deliveryState(results) {
  const channels = Object.values(results);
  if (channels.some(c => c.status === 'pending_receipt')) return 'pending_receipt';
  if (channels.some(c => c.status === 'retrying')) return 'retrying';
  if (channels.some(c => c.status === 'accepted')) return 'accepted';
  if (channels.some(c => c.status === 'unregistered')) return 'unregistered';
  return 'failed';
}

async function deliverRow(row) {
  try {
    if (Date.now() - new Date(row.createdAt).getTime() >= 24 * 60 * 60 * 1000) {
      const results = Object.fromEntries(Object.entries(row.providerResults).map(([provider, result]) => [
        provider, result.status === 'accepted' ? result : { ...result, status: 'failed', error: 'NOTIFICATION_EXPIRED' },
      ]));
      await row.update({
        status: deliveryState(results), providerResults: results,
        lockedUntil: null, lastError: 'NOTIFICATION_EXPIRED',
      });
      return;
    }
    const active = await getActiveParentIdsForSchool([row.receiverId], row.schoolId);
    if (!active.has(row.receiverId)) {
      await row.update({ status: 'cancelled', lockedUntil: null, lastError: 'PARENT_ACCESS_INACTIVE' });
      return;
    }
    const guardian = await Student.findOne({
      where: { id: row.payload.studentId, parentId: row.receiverId, schoolId: row.schoolId, isActive: true },
    });
    if (!guardian) {
      await row.update({ status: 'cancelled', lockedUntil: null, lastError: 'RECIPIENT_ACCESS_INACTIVE' });
      return;
    }
    if (row.event === 'driver-approaching') {
      const trip = await Trip.findByPk(row.tripId);
      const logs = trip ? await TripLog.findAll({ where: { tripId: trip.id } }) : [];
      const state = trip ? getTripState(trip, logs) : null;
      const student = state?.pickupList.find(s => s.studentId === row.payload.studentId);
      const eligible = row.payload.phase === 'pickup'
        ? ['pending', 'arrived_pickup'].includes(student?.status)
        : ['on_bus', 'arrived_dropoff'].includes(student?.status);
      if (trip?.status !== 'in_progress' || !eligible || !locationFreshness(row.payload.recordedAt).isFresh) {
        await row.update({ status: 'cancelled', lockedUntil: null, lastError: 'STALE_PROXIMITY_ALERT' });
        return;
      }
    }
    emitUser(row.receiverId, row.event, row.payload);
    const results = await deliverOutboxPush(
      row.receiverId, PUSH_TITLES[row.event] || 'School Transport Update',
      row.payload.message, { event: row.event, ...row.payload }, row.providerResults,
    );
    let status = deliveryState(results);
    if (row.attempts >= 12 && status !== 'pending_receipt' && status !== 'accepted') status = 'failed';
    const errors = Object.values(results).map(c => c.error).filter(Boolean);
    await row.update({
      status, providerResults: results, lockedUntil: null,
      lastError: status === 'failed' && !errors.length ? 'RECEIPT_EXPIRED' : errors.join(', ').slice(0, 200) || null,
      nextAttemptAt: new Date(Date.now() + (status === 'pending_receipt' ? 15 * 60 * 1000
        : Math.min(15 * 60 * 1000, 10000 * 2 ** Math.min(row.attempts, 10)))),
    });
  } catch (error) {
    console.error(`Notification outbox event ${row.id} failed: ${error.message}`);
    await row.update({
      status: row.attempts >= 12 ? 'failed' : 'retrying',
      lockedUntil: null, lastError: 'DELIVERY_PROCESSING_FAILED',
      nextAttemptAt: new Date(Date.now() + 60000),
    });
  }
}

async function processNotificationOutbox() {
  const rows = await sequelize.transaction(async transaction => {
    const now = new Date();
    const pending = await NotificationOutbox.findAll({
      where: {
        nextAttemptAt: { [Op.lte]: now },
        [Op.or]: [
          { status: { [Op.in]: ['pending', 'retrying', 'unregistered', 'pending_receipt'] } },
          { status: 'processing', lockedUntil: { [Op.lt]: now } },
        ],
      },
      order: [['id', 'ASC']], limit: 6, transaction, lock: transaction.LOCK.UPDATE, skipLocked: true,
    });
    for (const row of pending) {
      await row.update({
        status: 'processing', attempts: row.attempts + 1,
        lockedUntil: new Date(Date.now() + 5 * 60 * 1000),
      }, { transaction });
    }
    return pending;
  });
  await Promise.all(rows.map(deliverRow));
  return rows.length;
}

function wakeNotificationWorker() {
  if (!timer || running) return;
  let processed = 0;
  running = processNotificationOutbox()
    .then(count => { processed = count; })
    .catch(error => console.error('Notification outbox processing failed:', error.message))
    .finally(() => {
      running = null;
      if (timer && processed === 6) setImmediate(wakeNotificationWorker);
    });
}

function startNotificationWorker() {
  if (timer) return;
  timer = setInterval(wakeNotificationWorker, 10000);
  timer.unref();
  wakeNotificationWorker();
}

function stopNotificationWorker() {
  clearInterval(timer);
  timer = null;
}

module.exports = {
  enqueueNotification, processNotificationOutbox, deliveryState,
  startNotificationWorker, stopNotificationWorker,
};
