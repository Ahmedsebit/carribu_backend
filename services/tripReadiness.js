const { Route, RouteWaypoint, Student, User, Vehicle } = require('../models');
const { buildTripPlan, validateTripPlan } = require('./tripPlan');

async function getReadyRoute(routeId, schoolId, type, transaction) {
  const id = Number(routeId);
  if (!['string', 'number'].includes(typeof routeId) || !Number.isSafeInteger(id) || id <= 0) {
    throw Object.assign(new Error('A valid routeId is required.'), { status: 400 });
  }
  const route = await Route.findOne({
    where: { id, schoolId }, transaction,
    include: [
      { model: RouteWaypoint, as: 'routeWaypoints' },
      { model: Student, as: 'students', include: [{ model: User, as: 'parent' }] },
    ],
  });
  if (!route) throw Object.assign(new Error('Route not found.'), { status: 404 });
  if (!route.isActive) throw Object.assign(new Error('Reactivate this route before scheduling trips.'), { status: 409 });
  const direction = type === 'morning_pickup' ? 'morning' : 'afternoon';
  if (!['both', direction].includes(route.type)) {
    throw Object.assign(new Error('The trip direction does not match this route.'), { status: 409 });
  }
  const [driver, vehicle] = await Promise.all([
    User.findOne({ where: { id: route.driverId, schoolId, role: 'driver', isActive: true }, transaction }),
    Vehicle.findOne({ where: { id: route.vehicleId, schoolId, status: 'active' }, transaction, lock: transaction.LOCK.UPDATE }),
  ]);
  if (!driver || !vehicle) {
    throw Object.assign(new Error('Assign an active driver and an active vehicle before scheduling.'), { status: 409 });
  }
  if (route.students.some(student => student.isActive !== false && student.schoolId !== schoolId)) {
    throw Object.assign(new Error('Every active route student must belong to this school.'), { status: 409 });
  }
  const plan = buildTripPlan({ type }, route, route.routeWaypoints);
  const invalid = validateTripPlan(plan);
  if (invalid) throw Object.assign(new Error(invalid), { status: 422 });
  if (plan.stops.length > vehicle.capacity) {
    throw Object.assign(new Error('The active student roster exceeds vehicle capacity.'), { status: 409 });
  }
  return { route, plan, studentIds: plan.stops.map(stop => stop.studentId) };
}

module.exports = { getReadyRoute };
