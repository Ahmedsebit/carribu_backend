const { Route, Vehicle, User, Student, RouteStudent, RouteWaypoint, Trip, TripLog } = require('../models');
const { Op } = require('sequelize');
exports.getAll = async (req, res) => {
  try {
    const routes = await Route.findAll({ where: { schoolId: req.user.schoolId }, include: [
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','capacity'] },
      { model: User, as: 'driver', attributes: ['id','firstName','lastName','phone'] },
      { model: Student, as: 'students', attributes: ['id','firstName','lastName','grade'], through: { attributes: ['stopOrder'] } },
      { model: RouteWaypoint, as: 'routeWaypoints', order: [['leg', 'ASC'], ['orderIndex', 'ASC']] },
    ], order: [['name','ASC']] });
    res.json({ routes, total: routes.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getById = async (req, res) => {
  try {
    const route = await Route.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId }, include: [
      { model: Vehicle, as: 'vehicle' },
      { model: User, as: 'driver', attributes: { exclude: ['passwordHash'] } },
      { model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','pickupAddress','pickupLat','pickupLng'] }] },
      { model: RouteWaypoint, as: 'routeWaypoints', order: [['leg', 'ASC'], ['orderIndex', 'ASC']] },
    ]});
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    res.json({ route });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getTripHistory = async (req, res) => {
  try {
    const route = await Route.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId },
      include: [
        { model: Vehicle, as: 'vehicle', attributes: ['id', 'plateNumber', 'make', 'model', 'capacity'] },
        { model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName', 'phone'] },
        {
          model: Student,
          as: 'students',
          attributes: ['id', 'firstName', 'lastName', 'grade'],
          through: { attributes: ['stopOrder'] },
        },
      ],
    });
    if (!route) return res.status(404).json({ error: 'Route not found.' });

    const days = req.query.days === 'all' ? null : Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const where = { routeId: route.id };
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      where.scheduledDate = { [Op.gte]: since.toISOString().split('T')[0] };
    }

    const rows = await Trip.findAll({
      where,
      include: [
        { model: Vehicle, as: 'vehicle', attributes: ['id', 'plateNumber', 'make', 'model'] },
        { model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName'] },
        { model: TripLog, as: 'logs', attributes: ['id', 'studentId', 'action', 'timestamp'] },
      ],
      order: [['scheduled_date', 'DESC'], ['started_at', 'DESC']],
    });

    const expected = route.students?.length || 0;
    const trips = rows.map(row => {
      const trip = row.toJSON();
      const boarded = new Set(trip.logs.filter(log => log.action === 'check_in').map(log => log.studentId)).size;
      const droppedOff = new Set(trip.logs.filter(log => log.action === 'check_out').map(log => log.studentId)).size;
      const absent = new Set(trip.logs.filter(log => log.action === 'absent').map(log => log.studentId)).size;
      const durationMinutes = trip.startedAt && trip.endedAt
        ? Math.max(0, Math.round((new Date(trip.endedAt) - new Date(trip.startedAt)) / 60000))
        : null;
      return {
        id: trip.id,
        scheduledDate: trip.scheduledDate,
        scheduledTime: trip.scheduledTime,
        type: trip.type,
        status: trip.status,
        startedAt: trip.startedAt,
        endedAt: trip.endedAt,
        durationMinutes,
        vehicle: trip.vehicle,
        driver: trip.driver,
        attendance: {
          expected,
          boarded,
          droppedOff,
          absent,
          notBoarded: Math.max(0, expected - boarded - absent),
        },
      };
    });

    const completedDurations = trips
      .filter(trip => trip.status === 'completed' && trip.durationMinutes != null)
      .map(trip => trip.durationMinutes);
    const vehicleUsage = new Map();
    const driverUsage = new Map();
    trips.forEach(trip => {
      if (trip.vehicle) vehicleUsage.set(trip.vehicle.id, {
        id: trip.vehicle.id,
        plateNumber: trip.vehicle.plateNumber,
        trips: (vehicleUsage.get(trip.vehicle.id)?.trips || 0) + 1,
      });
      if (trip.driver) driverUsage.set(trip.driver.id, {
        id: trip.driver.id,
        name: `${trip.driver.firstName} ${trip.driver.lastName}`,
        trips: (driverUsage.get(trip.driver.id)?.trips || 0) + 1,
      });
    });
    const attendance = trips.reduce((totals, trip) => {
      totals.expected += trip.attendance.expected;
      totals.boarded += trip.attendance.boarded;
      totals.droppedOff += trip.attendance.droppedOff;
      totals.absent += trip.attendance.absent;
      totals.notBoarded += trip.attendance.notBoarded;
      return totals;
    }, { expected: 0, boarded: 0, droppedOff: 0, absent: 0, notBoarded: 0 });
    const completed = trips.filter(trip => trip.status === 'completed').length;

    res.json({
      route,
      period: days ? `${days} days` : 'all time',
      stats: {
        totalTrips: trips.length,
        completed,
        inProgress: trips.filter(trip => trip.status === 'in_progress').length,
        scheduled: trips.filter(trip => trip.status === 'scheduled').length,
        delayed: trips.filter(trip => trip.status === 'delayed').length,
        missed: trips.filter(trip => trip.status === 'missed').length,
        cancelled: trips.filter(trip => trip.status === 'cancelled').length,
        completionRate: trips.length ? Math.round((completed / trips.length) * 100) : 0,
        averageDurationMinutes: completedDurations.length
          ? Math.round(completedDurations.reduce((sum, duration) => sum + duration, 0) / completedDurations.length)
          : null,
        totalOperatingMinutes: completedDurations.reduce((sum, duration) => sum + duration, 0),
        uniqueDrivers: driverUsage.size,
        uniqueVehicles: vehicleUsage.size,
        attendance,
      },
      driverUsage: [...driverUsage.values()].sort((a, b) => b.trips - a.trips),
      vehicleUsage: [...vehicleUsage.values()].sort((a, b) => b.trips - a.trips),
      trips,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try {
    const { studentIds, outboundWaypoints, returnWaypoints, ...routeData } = req.body;
    const route = await Route.create({ ...routeData, schoolId: req.user.schoolId });

    if (studentIds && studentIds.length > 0) {
      await RouteStudent.bulkCreate(studentIds.map((sid, i) => ({ routeId: route.id, studentId: sid, stopOrder: i + 1 })));
    }

    // Save outbound waypoints (A → B)
    if (outboundWaypoints && outboundWaypoints.length > 0) {
      await RouteWaypoint.bulkCreate(outboundWaypoints.map((wp, i) => ({
        routeId: route.id, leg: 'outbound', orderIndex: i,
        lat: wp.lat, lng: wp.lng, label: wp.label || null, isStop: wp.isStop || false,
      })));
    }

    // Save return waypoints (B → A)
    if (returnWaypoints && returnWaypoints.length > 0) {
      await RouteWaypoint.bulkCreate(returnWaypoints.map((wp, i) => ({
        routeId: route.id, leg: 'return', orderIndex: i,
        lat: wp.lat, lng: wp.lng, label: wp.label || null, isStop: wp.isStop || false,
      })));
    }

    const full = await Route.findByPk(route.id, { include: [
      { model: Vehicle, as: 'vehicle' },
      { model: User, as: 'driver', attributes: { exclude: ['passwordHash'] } },
      { model: Student, as: 'students', through: { attributes: ['stopOrder'] } },
      { model: RouteWaypoint, as: 'routeWaypoints', order: [['leg', 'ASC'], ['orderIndex', 'ASC']] },
    ]});
    res.status(201).json({ message: 'Route created.', route: full });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.update = async (req, res) => {
  try {
    const route = await Route.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!route) return res.status(404).json({ error: 'Route not found.' });

    const { studentIds, outboundWaypoints, returnWaypoints, ...routeData } = req.body;
    const prevDriverId = route.driverId;
    const prevVehicleId = route.vehicleId;
    await route.update(routeData);

    // Propagate a driver/vehicle change to this route's still-actionable trips
    // so their snapshot stays in sync (the driver app also matches on the
    // route's current driver, but keeping the snapshot correct keeps admin
    // listings and parent notifications accurate).
    if (route.driverId !== prevDriverId || route.vehicleId !== prevVehicleId) {
      await Trip.update(
        { driverId: route.driverId, vehicleId: route.vehicleId },
        { where: { routeId: route.id, status: ['scheduled', 'in_progress'] } }
      );
    }

    if (studentIds) {
      await RouteStudent.destroy({ where: { routeId: route.id } });
      await RouteStudent.bulkCreate(studentIds.map((sid, i) => ({ routeId: route.id, studentId: sid, stopOrder: i + 1 })));
    }

    // Replace outbound waypoints if provided
    if (outboundWaypoints) {
      await RouteWaypoint.destroy({ where: { routeId: route.id, leg: 'outbound' } });
      if (outboundWaypoints.length > 0) {
        await RouteWaypoint.bulkCreate(outboundWaypoints.map((wp, i) => ({
          routeId: route.id, leg: 'outbound', orderIndex: i,
          lat: wp.lat, lng: wp.lng, label: wp.label || null, isStop: wp.isStop || false,
        })));
      }
    }

    // Replace return waypoints if provided
    if (returnWaypoints) {
      await RouteWaypoint.destroy({ where: { routeId: route.id, leg: 'return' } });
      if (returnWaypoints.length > 0) {
        await RouteWaypoint.bulkCreate(returnWaypoints.map((wp, i) => ({
          routeId: route.id, leg: 'return', orderIndex: i,
          lat: wp.lat, lng: wp.lng, label: wp.label || null, isStop: wp.isStop || false,
        })));
      }
    }

    const full = await Route.findByPk(route.id, { include: [
      { model: Vehicle, as: 'vehicle' },
      { model: User, as: 'driver', attributes: { exclude: ['passwordHash'] } },
      { model: Student, as: 'students', through: { attributes: ['stopOrder'] } },
      { model: RouteWaypoint, as: 'routeWaypoints', order: [['leg', 'ASC'], ['orderIndex', 'ASC']] },
    ]});
    res.json({ message: 'Route updated.', route: full });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.delete = async (req, res) => {
  try {
    const route = await Route.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    await route.update({ isActive: false }); res.json({ message: 'Route deactivated.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// Suggest students who match route criteria (grades + proximity to waypoints)
exports.suggestStudents = async (req, res) => {
  try {
    const { grades, waypoints, radiusKm } = req.body;
    const radius = radiusKm || 3; // default 3km radius

    // Get all students in this school with their parent's location
    const where = { schoolId: req.user.schoolId, isActive: true };
    const students = await Student.findAll({
      where,
      include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','pickupAddress','pickupLat','pickupLng'] }],
    });

    let suggested = students;

    // Filter by grades if provided
    if (grades && grades.length > 0) {
      suggested = suggested.filter(s => grades.includes(s.grade));
    }

    // Filter by proximity to waypoints if provided
    if (waypoints && waypoints.length > 0) {
      suggested = suggested.filter(s => {
        if (!s.parent?.pickupLat || !s.parent?.pickupLng) return false;
        const studentLat = parseFloat(s.parent.pickupLat);
        const studentLng = parseFloat(s.parent.pickupLng);
        // Check if student is within radius of any waypoint
        const minDist = Math.min(...waypoints.map(wp => haversineDistance(studentLat, studentLng, wp.lat, wp.lng)));
        s._distanceKm = minDist;
        return minDist <= radius;
      });
    }

    res.json({
      students: suggested.map(s => ({
        id: s.id,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.grade,
        parentName: s.parent ? `${s.parent.firstName} ${s.parent.lastName}` : null,
        pickupAddress: s.parent?.pickupAddress,
        pickupLat: s.parent?.pickupLat ? parseFloat(s.parent.pickupLat) : null,
        pickupLng: s.parent?.pickupLng ? parseFloat(s.parent.pickupLng) : null,
        distanceKm: s._distanceKm || null,
      })),
      total: suggested.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// Haversine formula to calculate distance between two points in km
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
