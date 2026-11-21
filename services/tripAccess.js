const { Op } = require('sequelize');
const { Trip, Route, Student } = require('../models');
const { hasActiveParentSchool } = require('../utils/parentSchoolAccess');

async function getAccessibleTrip(tripId, user) {
  const id = Number(tripId);
  if (!Number.isSafeInteger(id) || id < 1
    || !['super_admin', 'school_admin', 'coordinator', 'driver', 'parent'].includes(user.role)) return null;
  const trip = await Trip.findByPk(id, {
    include: [{ model: Route, as: 'route', attributes: ['id', 'schoolId'], required: true }],
  });
  if (!trip?.route) return null;
  if (user.role === 'super_admin') return { trip, studentIds: null };
  if (trip.plan?.schoolId != null && trip.plan.schoolId !== trip.route.schoolId) return null;
  if (user.role !== 'parent') {
    if (trip.route.schoolId !== user.schoolId || (user.role === 'driver' && trip.driverId !== user.id)) return null;
    return { trip, studentIds: null };
  }
  if (!await hasActiveParentSchool(user.id, trip.route.schoolId)) return null;
  const where = { parentId: user.id, schoolId: trip.route.schoolId, isActive: true };
  const frozen = trip.plan && !(['scheduled', 'delayed'].includes(trip.status) && !trip.startedAt);
  if (frozen) {
    const stops = Array.isArray(trip.plan.stops) ? trip.plan.stops : [];
    const ids = stops.filter(stop => stop.parentId === user.id).map(stop => stop.studentId);
    if (!ids.length) return null;
    where.id = { [Op.in]: ids };
  }
  const children = await Student.findAll({
    where, attributes: ['id'],
    include: frozen ? [] : [{
      model: Route, as: 'routes', where: { id: trip.routeId, schoolId: trip.route.schoolId },
      attributes: [], through: { attributes: [] }, required: true,
    }],
  });
  return children.length ? { trip, studentIds: children.map(child => child.id) } : null;
}

module.exports = { getAccessibleTrip };
