const { Student, User, RouteStudent, RouteWaypoint } = require('../models');

function haversineDistance(lat1, lng1, lat2, lng2) {
  const radiusKm = 6371;
  const toRadians = value => value * Math.PI / 180;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLng / 2) ** 2;
  return radiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getRouteStart(routeId, transaction) {
  const waypoint = await RouteWaypoint.findOne({
    where: { routeId, leg: 'outbound' },
    order: [['orderIndex', 'ASC']],
    transaction,
  });
  if (!waypoint) return null;
  return { lat: Number(waypoint.lat), lng: Number(waypoint.lng) };
}

async function orderStudentIdsByPickupDistance(studentIds, startPoint, schoolId, transaction) {
  const uniqueIds = [...new Set((studentIds || []).map(Number).filter(Number.isInteger))];
  if (!startPoint || uniqueIds.length < 2) return uniqueIds;

  const students = await Student.findAll({
    where: { id: uniqueIds, schoolId },
    attributes: ['id'],
    include: [{
      model: User,
      as: 'parent',
      attributes: ['pickupLat', 'pickupLng'],
    }],
    transaction,
  });
  const byId = new Map(students.map(student => [student.id, student]));
  const originalIndex = new Map(uniqueIds.map((id, index) => [id, index]));

  return [...uniqueIds].sort((leftId, rightId) => {
    const left = byId.get(leftId)?.parent;
    const right = byId.get(rightId)?.parent;
    const leftHasLocation =
      left?.pickupLat != null && left.pickupLat !== '' &&
      left?.pickupLng != null && left.pickupLng !== '';
    const rightHasLocation =
      right?.pickupLat != null && right.pickupLat !== '' &&
      right?.pickupLng != null && right.pickupLng !== '';
    if (leftHasLocation !== rightHasLocation) return leftHasLocation ? -1 : 1;
    if (!leftHasLocation) return originalIndex.get(leftId) - originalIndex.get(rightId);

    const leftDistance = haversineDistance(
      startPoint.lat,
      startPoint.lng,
      Number(left.pickupLat),
      Number(left.pickupLng)
    );
    const rightDistance = haversineDistance(
      startPoint.lat,
      startPoint.lng,
      Number(right.pickupLat),
      Number(right.pickupLng)
    );
    return leftDistance - rightDistance || originalIndex.get(leftId) - originalIndex.get(rightId);
  });
}

async function replaceRouteStudentOrder(routeId, studentIds, startPoint, schoolId, transaction) {
  const orderedIds = await orderStudentIdsByPickupDistance(
    studentIds,
    startPoint,
    schoolId,
    transaction
  );
  await RouteStudent.destroy({ where: { routeId }, transaction });
  if (orderedIds.length > 0) {
    await RouteStudent.bulkCreate(
      orderedIds.map((studentId, index) => ({
        routeId,
        studentId,
        stopOrder: index + 1,
      })),
      { transaction }
    );
  }
  return orderedIds;
}

function sortStudentsForTrip(students, tripType) {
  const direction = tripType === 'afternoon_dropoff' ? -1 : 1;
  return [...(students || [])].sort(
    (left, right) =>
      direction *
      ((left.RouteStudent?.stopOrder || 0) - (right.RouteStudent?.stopOrder || 0))
  );
}

module.exports = {
  getRouteStart,
  orderStudentIdsByPickupDistance,
  replaceRouteStudentOrder,
  sortStudentsForTrip,
};
