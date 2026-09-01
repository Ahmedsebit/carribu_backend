const crypto = require('crypto');
const { User, Vehicle, Route, School, Trip, TripLog, Student, sequelize } = require('../models');
const { Op } = require('sequelize');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('../utils/email');
const { normalizePhoneE164 } = require('../utils/phone');

const generatePassword = () => crypto.randomBytes(4).toString('hex');

exports.listDrivers = async (req, res) => {
  try {
    const drivers = await User.findAll({
      where: { schoolId: req.user.schoolId, role: 'driver', isActive: true },
      attributes: { exclude: ['passwordHash'] },
      include: [{ model: Route, as: 'assignedRoutes', attributes: ['id','name','type'], where: { isActive: true }, required: false, include: [{ model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model'] }] }],
      order: [['firstName', 'ASC']],
    });
    res.json({ drivers });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getDriver = async (req, res) => {
  try {
    const driver = await User.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' },
      attributes: { exclude: ['passwordHash'] },
      include: [{ model: Route, as: 'assignedRoutes', where: { isActive: true }, required: false, include: [{ model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model'] }] }],
    });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    res.json({ driver });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getTripHistory = async (req, res) => {
  try {
    const driver = await User.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' },
      attributes: { exclude: ['passwordHash'] },
      include: [{
        model: Route,
        as: 'assignedRoutes',
        attributes: ['id', 'name'],
        include: [{ model: Vehicle, as: 'vehicle', attributes: ['id', 'plateNumber', 'make', 'model'] }],
      }],
    });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const days = req.query.days === 'all' ? null : Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const where = { driverId: driver.id };
    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      where.scheduledDate = { [Op.gte]: since.toISOString().split('T')[0] };
    }

    const rows = await Trip.findAll({
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
        { model: Vehicle, as: 'vehicle', attributes: ['id', 'plateNumber', 'make', 'model'] },
        { model: TripLog, as: 'logs', attributes: ['id', 'studentId', 'action', 'timestamp'] },
      ],
      order: [['scheduled_date', 'DESC'], ['started_at', 'DESC']],
    });

    const trips = rows.map(row => {
      const trip = row.toJSON();
      const expected = trip.route?.students?.length || 0;
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
        route: trip.route ? { id: trip.route.id, name: trip.route.name } : null,
        vehicle: trip.vehicle,
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
    const routeUsage = new Map();
    const vehicleUsage = new Map();
    trips.forEach(trip => {
      if (trip.route) routeUsage.set(trip.route.id, {
        id: trip.route.id,
        name: trip.route.name,
        trips: (routeUsage.get(trip.route.id)?.trips || 0) + 1,
      });
      if (trip.vehicle) vehicleUsage.set(trip.vehicle.id, {
        id: trip.vehicle.id,
        plateNumber: trip.vehicle.plateNumber,
        trips: (vehicleUsage.get(trip.vehicle.id)?.trips || 0) + 1,
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
      driver,
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
        totalDrivingMinutes: completedDurations.reduce((sum, duration) => sum + duration, 0),
        uniqueRoutes: routeUsage.size,
        uniqueVehicles: vehicleUsage.size,
        attendance,
      },
      routeUsage: [...routeUsage.values()].sort((a, b) => b.trips - a.trips),
      vehicleUsage: [...vehicleUsage.values()].sort((a, b) => b.trips - a.trips),
      trips,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.createDriver = async (req, res) => {
  try {
    const { email, firstName, lastName, phone } = req.body;
    if (!email || !firstName || !lastName) {
      return res.status(400).json({ error: 'email, firstName, and lastName are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone ? normalizePhoneE164(phone) : null;
    if (phone && !normalizedPhone) return res.status(400).json({ error: 'A valid phone number is required' });
    const identities = [{ email: normalizedEmail }];
    if (normalizedPhone) identities.push({ phone: normalizedPhone });
    const existing = await User.findOne({
      where: { schoolId: req.user.schoolId, [Op.or]: identities },
    });
    if (existing) return res.status(409).json({ error: 'A user with this email or phone number already exists' });

    const tempPassword = generatePassword();
    const driver = await User.create({
      schoolId: req.user.schoolId,
      email: normalizedEmail,
      passwordHash: tempPassword,
      firstName,
      lastName,
      role: 'driver',
      phone: normalizedPhone,
    });

    const school = await School.findByPk(req.user.schoolId);
    const emailResult = await sendWelcomeEmail(email, firstName, tempPassword, school?.name || 'Your School');

    res.status(201).json({
      driver: { ...driver.toJSON(), passwordHash: undefined },
      tempPassword,
      emailSent: emailResult.sent || false,
      previewUrl: emailResult.previewUrl || null,
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A user with this email or phone number already exists' });
    res.status(500).json({ error: err.message });
  }
};

exports.updateDriver = async (req, res) => {
  try {
    const driver = await User.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    const { firstName, lastName, phone } = req.body;
    const normalizedPhone = phone ? normalizePhoneE164(phone) : null;
    if (phone && !normalizedPhone) return res.status(400).json({ error: 'A valid phone number is required' });
    if (normalizedPhone) {
      const existing = await User.findOne({
        where: {
          schoolId: req.user.schoolId,
          phone: normalizedPhone,
          id: { [Op.ne]: driver.id },
        },
      });
      if (existing) return res.status(409).json({ error: 'A user with this phone number already exists' });
    }
    await driver.update({ firstName, lastName, phone: normalizedPhone });
    res.json({ driver: { ...driver.toJSON(), passwordHash: undefined }, message: 'Driver updated.' });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A user with this email or phone number already exists' });
    res.status(500).json({ error: err.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const driver = await User.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const newPassword = generatePassword();
    await driver.update({ passwordHash: newPassword });

    const school = await School.findByPk(req.user.schoolId);
    const emailResult = await sendPasswordResetEmail(driver.email, driver.firstName, newPassword, school?.name || 'Your School');

    res.json({
      message: 'Password reset successfully.',
      tempPassword: newPassword,
      emailSent: emailResult.sent || false,
      previewUrl: emailResult.previewUrl || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteDriver = async (req, res) => {
  try {
    const result = await sequelize.transaction(async (transaction) => {
      const driver = await User.findOne({
        where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!driver) return { status: 404, error: 'Driver not found' };

      const activeTrip = await Trip.findOne({
        where: { driverId: driver.id, status: 'in_progress' },
        transaction,
      });
      if (activeTrip) {
        return {
          status: 409,
          error: 'This driver has a trip in progress. End the trip before deleting the driver.',
        };
      }

      await driver.destroy({ transaction });
      return { status: 200 };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ message: 'Driver deleted.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
