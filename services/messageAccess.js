const { User, Route, Student, Trip } = require('../models');
const { hasActiveParentSchool } = require('../utils/parentSchoolAccess');
const { getAccessibleTrip } = require('./tripAccess');

const staffRoles = new Set(['school_admin', 'coordinator']);
const positiveId = value => {
  if (!['number', 'string'].includes(typeof value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

async function driverHasParent(driver, parent, transaction) {
  if (!await hasActiveParentSchool(parent.id, driver.schoolId, transaction)) return false;
  const route = await Route.findOne({
    where: { driverId: driver.id, schoolId: driver.schoolId, isActive: true },
    include: [{
      model: Student, as: 'students', required: true, attributes: ['id'],
      where: { parentId: parent.id, schoolId: driver.schoolId, isActive: true },
      through: { attributes: [] },
    }],
    transaction,
  });
  if (route) return true;
  const children = await Student.findAll({
    where: { parentId: parent.id, schoolId: driver.schoolId, isActive: true }, attributes: ['id'], transaction,
  });
  if (!children.length) return false;
  const ids = new Set(children.map(child => child.id));
  const trips = await Trip.findAll({
    where: { driverId: driver.id, status: 'in_progress' },
    include: [{ model: Route, as: 'route', where: { schoolId: driver.schoolId }, required: true, attributes: ['id', 'schoolId'] }],
    transaction,
  });
  for (const trip of trips) {
    if (trip.plan) {
      if (trip.plan.schoolId != null && trip.plan.schoolId !== driver.schoolId) continue;
      if (trip.plan.stops?.some(stop => ids.has(stop.studentId) && stop.parentId === parent.id)) return true;
    } else if (await getAccessibleTrip(trip.id, parent)) return true;
  }
  return false;
}

async function getMessagePermission(sender, receiverValue, { tripId, transaction } = {}) {
  const receiverId = positiveId(receiverValue);
  if (!receiverId || receiverId === sender.id || sender.isActive === false) return null;
  const receiver = await User.findByPk(receiverId, {
    attributes: ['id', 'firstName', 'lastName', 'role', 'schoolId', 'isActive', 'mustSetPassword'], transaction,
  });
  if (!receiver?.isActive) return null;
  let schoolId;
  const parent = sender.role === 'parent' ? sender : receiver.role === 'parent' ? receiver : null;
  if (parent) {
    if (parent.mustSetPassword) return null;
    const other = parent.id === sender.id ? receiver : sender;
    schoolId = other.schoolId;
    if (!schoolId || !await hasActiveParentSchool(parent.id, schoolId, transaction)) return null;
    if (other.role === 'driver') {
      if (!await driverHasParent(other, parent, transaction)) return null;
    } else if (!staffRoles.has(other.role)) return null;
  } else {
    schoolId = sender.schoolId;
    if (!schoolId || receiver.schoolId !== schoolId
      || !(staffRoles.has(sender.role) && (staffRoles.has(receiver.role) || receiver.role === 'driver')
        || sender.role === 'driver' && staffRoles.has(receiver.role))) return null;
  }
  if (tripId != null) {
    if (!positiveId(tripId)) return null;
    const [senderAccess, receiverAccess] = await Promise.all([
      getAccessibleTrip(tripId, sender), getAccessibleTrip(tripId, receiver),
    ]);
    if (!senderAccess || !receiverAccess || senderAccess.trip.route.schoolId !== schoolId) return null;
  }
  return { receiver, schoolId };
}

async function canDeliverMessage(message) {
  if (!message || message.receiverDeletedAt) return false;
  const sender = await User.findByPk(message.senderId, {
    attributes: ['id', 'firstName', 'lastName', 'role', 'schoolId', 'isActive', 'mustSetPassword'],
  });
  if (!sender?.isActive) return false;
  if (message.messageType === 'alert') {
    if (!staffRoles.has(sender.role) || sender.schoolId !== message.schoolId) return false;
    const receiver = await User.findByPk(message.receiverId, { attributes: ['id', 'role', 'isActive', 'mustSetPassword'] });
    if (!receiver?.isActive || receiver.role !== 'parent' || receiver.mustSetPassword
      || !await hasActiveParentSchool(receiver.id, message.schoolId)) return false;
    return !message.tripId || !!await getAccessibleTrip(message.tripId, receiver);
  }
  const permission = await getMessagePermission(sender, message.receiverId, { tripId: message.tripId });
  return permission?.schoolId === message.schoolId;
}

module.exports = { positiveId, getMessagePermission, canDeliverMessage };
