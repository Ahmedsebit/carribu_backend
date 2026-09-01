const { Vehicle, School, Route, User, Trip, TripLog, Student } = require('../models');
const { Op } = require('sequelize');
exports.getAll = async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    if (req.query.status) where.status = req.query.status;
    if (req.query.search) where[Op.or] = [{ plateNumber: { [Op.iLike]: `%${req.query.search}%` } }, { make: { [Op.iLike]: `%${req.query.search}%` } }, { model: { [Op.iLike]: `%${req.query.search}%` } }];
    const vehicles = await Vehicle.findAll({ where, include: [{ model: School, as: 'school', attributes: ['id','name'] }, { model: Route, as: 'routes', attributes: ['id','name'], include: [{ model: User, as: 'driver', attributes: ['id','firstName','lastName'] }] }], order: [['created_at','DESC']] });
    res.json({ vehicles, total: vehicles.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getById = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId }, include: [{ model: School, as: 'school', attributes: ['id','name'] }, { model: Route, as: 'routes', include: [{ model: User, as: 'driver', attributes: ['id','firstName','lastName','phone'] }] }] });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
    res.json({ vehicle });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getTripHistory = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId },
      include: [{
        model: Route,
        as: 'routes',
        attributes: ['id', 'name'],
        include: [{ model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName'] }],
      }],
    });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });

    const days = req.query.days === 'all' ? null : Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const where = { vehicleId: vehicle.id };
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      where.scheduledDate = { [Op.gte]: since.toISOString().split('T')[0] };
    }

    const tripRows = await Trip.findAll({
      where,
      include: [
        {
          model: Route,
          as: 'route',
          where: { schoolId: req.user.schoolId },
          attributes: ['id', 'name'],
          include: [{
            model: Student,
            as: 'students',
            attributes: ['id'],
            through: { attributes: [] },
          }],
        },
        { model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName'] },
        { model: TripLog, as: 'logs', attributes: ['id', 'studentId', 'action', 'timestamp'] },
      ],
      order: [['scheduled_date', 'DESC'], ['started_at', 'DESC']],
    });

    const trips = tripRows.map(row => {
      const trip = row.toJSON();
      const expectedStudents = trip.route?.students?.length || 0;
      const boardedStudentIds = new Set(trip.logs.filter(log => log.action === 'check_in').map(log => log.studentId));
      const droppedStudentIds = new Set(trip.logs.filter(log => log.action === 'check_out').map(log => log.studentId));
      const absentStudentIds = new Set(trip.logs.filter(log => log.action === 'absent').map(log => log.studentId));
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
        route: trip.route ? { id: trip.route.id, name: trip.route.name } : null,
        driver: trip.driver,
        attendance: {
          expected: expectedStudents,
          boarded: boardedStudentIds.size,
          droppedOff: droppedStudentIds.size,
          absent: absentStudentIds.size,
          notBoarded: Math.max(0, expectedStudents - boardedStudentIds.size - absentStudentIds.size),
        },
      };
    });

    const completedDurations = trips
      .filter(trip => trip.status === 'completed' && trip.durationMinutes != null)
      .map(trip => trip.durationMinutes);
    const routeUsage = new Map();
    const driverUsage = new Map();
    trips.forEach(trip => {
      if (trip.route) routeUsage.set(trip.route.id, {
        id: trip.route.id,
        name: trip.route.name,
        trips: (routeUsage.get(trip.route.id)?.trips || 0) + 1,
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
      vehicle,
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
        uniqueRoutes: routeUsage.size,
        uniqueDrivers: driverUsage.size,
        attendance,
      },
      routeUsage: [...routeUsage.values()].sort((a, b) => b.trips - a.trips),
      driverUsage: [...driverUsage.values()].sort((a, b) => b.trips - a.trips),
      trips,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try {
    const plateNumber = String(req.body.plateNumber || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!plateNumber) return res.status(400).json({ error: 'Plate number is required.' });
    const existing = await Vehicle.findOne({ where: { plateNumber: { [Op.iLike]: plateNumber } } });
    if (existing) return res.status(409).json({ error: 'A vehicle with this plate number already exists.' });
    const vehicle = await Vehicle.create({ ...req.body, plateNumber, schoolId: req.user.schoolId });
    res.status(201).json({ message: 'Vehicle created.', vehicle });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A vehicle with this plate number already exists.' });
    res.status(500).json({ error: err.message });
  }
};
exports.update = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
    const updates = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(updates, 'plateNumber')) {
      updates.plateNumber = String(updates.plateNumber || '').trim().toUpperCase().replace(/\s+/g, ' ');
      if (!updates.plateNumber) return res.status(400).json({ error: 'Plate number is required.' });
      const existing = await Vehicle.findOne({ where: { plateNumber: { [Op.iLike]: updates.plateNumber }, id: { [Op.ne]: vehicle.id } } });
      if (existing) return res.status(409).json({ error: 'A vehicle with this plate number already exists.' });
    }
    await vehicle.update(updates); res.json({ message: 'Vehicle updated.', vehicle });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A vehicle with this plate number already exists.' });
    res.status(500).json({ error: err.message });
  }
};
exports.delete = async (req, res) => {
  try {
    const vehicle = await Vehicle.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found.' });
    await vehicle.update({ status: 'retired' }); res.json({ message: 'Vehicle retired.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getStats = async (req, res) => {
  try {
    const schoolId = req.user.schoolId;
    const [active, maintenance, retired, total] = await Promise.all([
      Vehicle.count({ where: { schoolId, status: 'active' } }), Vehicle.count({ where: { schoolId, status: 'maintenance' } }),
      Vehicle.count({ where: { schoolId, status: 'retired' } }), Vehicle.count({ where: { schoolId } }),
    ]);
    res.json({ stats: { total, active, maintenance, retired } });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
