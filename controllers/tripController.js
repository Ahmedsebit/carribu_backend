const { Trip, TripLog, Route, Vehicle, User, Student, Message, RouteStudent } = require('../models');
const { sequelize } = require('../models');
const { Op } = require('sequelize');
const { notifyUser, notifyTrip } = require('../socket');
const { checkDelayedTrips, checkMissedTrips, isStartWindowLapsed } = require('../services/tripReminders');

// Helper: calculate ETA based on stops away (avg 3 min per stop)
function estimateETA(stopsAway) {
  const minutes = stopsAway * 3;
  return { minutes, text: minutes <= 1 ? '~1 minute' : `~${minutes} minutes` };
}

exports.getAll = async (req, res) => {
  try {
    // Refresh delayed/missed-trip state before listing so the admin dashboard
    // shows trips that passed their start time (delayed) or lapsed the grace
    // window without being started (missed / "not started").
    await checkDelayedTrips(Date.now());
    await checkMissedTrips(Date.now());
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.date) where.scheduledDate = req.query.date;
    const trips = await Trip.findAll({ where, include: [
      { model: Route, as: 'route', where: { schoolId: req.user.schoolId }, attributes: ['id','name'], include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] } }] },
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model'] },
      { model: User, as: 'driver', attributes: ['id','firstName','lastName'] },
      { model: TripLog, as: 'logs' },
    ], order: [['scheduled_date','DESC'],['created_at','DESC']] });
    const result = trips.map(trip => {
      const t = trip.toJSON();
      const students = t.route?.students || [];
      const logs = t.logs || [];
      const studentStats = students.map(s => {
        const sl = logs.filter(l => l.studentId === s.id);
        let status = 'pending';
        if (sl.find(l => l.action === 'absent')) status = 'absent';
        else if (sl.find(l => l.action === 'check_out')) status = 'dropped_off';
        else if (sl.find(l => l.action === 'check_in')) status = 'on_bus';
        else if (sl.find(l => l.action === 'arrived')) status = 'arrived';
        return status;
      });
      t.studentStats = {
        total: students.length,
        pending: studentStats.filter(s => s === 'pending').length,
        arrived: studentStats.filter(s => s === 'arrived').length,
        onBus: studentStats.filter(s => s === 'on_bus').length,
        droppedOff: studentStats.filter(s => s === 'dropped_off').length,
        absent: studentStats.filter(s => s === 'absent').length,
      };
      delete t.logs;
      return t;
    });
    res.json({ trips: result, total: result.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try {
    const { routeId, type, scheduledDate, scheduledTime } = req.body;
    const route = await Route.findOne({ where: { id: routeId, schoolId: req.user.schoolId } });
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    const trip = await Trip.create({ routeId, driverId: route.driverId, vehicleId: route.vehicleId, type, scheduledDate, scheduledTime: scheduledTime || null, status: 'scheduled' });
    res.status(201).json({ message: 'Trip scheduled.', trip });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.startTrip = async (req, res) => {
  try {
    const trip = await Trip.findByPk(req.params.id, {
      include: [{
        model: Route, as: 'route', where: { schoolId: req.user.schoolId },
        include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','email'] }] }]
      }, { model: User, as: 'driver', attributes: ['id','firstName','lastName'] }]
    });
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    if (trip.status === 'missed') return res.status(400).json({ error: 'This trip was missed — it was not started within the allowed time window.' });
    // A driver acknowledges (and thereby starts) a trip that is either still
    // scheduled or already flagged 'delayed' for running past its start time.
    if (!['scheduled', 'delayed'].includes(trip.status)) return res.status(400).json({ error: 'Trip already started or completed.' });
    // Guard the race where the start window lapsed since the last sweep.
    if (isStartWindowLapsed(trip)) {
      await trip.update({ status: 'missed' });
      return res.status(400).json({ error: 'This trip was missed — it was not started within the allowed time window.' });
    }
    const studentIds = (trip.route?.students || []).map(student => student.id);
    let conflicts = [];
    let stateChangedWhileWaiting = false;

    await sequelize.transaction(async transaction => {
      // Serialize starts within a school so two simultaneous requests cannot
      // both pass the roster check before either status is persisted.
      await sequelize.query('SELECT pg_advisory_xact_lock(:schoolId)', {
        replacements: { schoolId: req.user.schoolId },
        transaction,
      });

      const currentTrip = await Trip.findByPk(trip.id, {
        attributes: ['status'],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!currentTrip || !['scheduled', 'delayed'].includes(currentTrip.status)) {
        stateChangedWhileWaiting = true;
        return;
      }

      if (studentIds.length > 0) {
        const activeTrips = await Trip.findAll({
          attributes: ['id'],
          where: { id: { [Op.ne]: trip.id }, status: 'in_progress' },
          include: [{
            model: Route,
            as: 'route',
            attributes: ['id', 'name'],
            required: true,
            where: { schoolId: req.user.schoolId },
            include: [{
              model: Student,
              as: 'students',
              attributes: ['id', 'admissionNumber', 'firstName', 'lastName'],
              required: true,
              where: { id: { [Op.in]: studentIds } },
              through: { attributes: [] },
            }],
          }],
          transaction,
        });

        conflicts = activeTrips.flatMap(activeTrip =>
          activeTrip.route.students.map(student => ({
            studentId: student.id,
            admissionNumber: student.admissionNumber,
            studentName: `${student.firstName} ${student.lastName}`,
            activeTripId: activeTrip.id,
            activeRouteName: activeTrip.route.name,
          }))
        );
      }

      if (conflicts.length === 0) {
        await trip.update({ status: 'in_progress', startedAt: new Date() }, { transaction });
      }
    });

    if (stateChangedWhileWaiting) {
      return res.status(400).json({ error: 'Trip already started or completed.' });
    }

    if (conflicts.length > 0) {
      const names = [...new Set(conflicts.map(conflict => conflict.studentName))];
      return res.status(409).json({
        error: `Trip cannot start because ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} already assigned to an active trip.`,
        conflicts,
      });
    }

    // Notify all parents on this route that the trip has started
    if (trip.route && trip.route.students) {
      const driverName = trip.driver ? `${trip.driver.firstName} ${trip.driver.lastName}` : 'Your driver';
      for (const student of trip.route.students) {
        if (student.parent) {
          const content = `🚌 Trip started! ${driverName} is now on the way to pick up ${student.firstName}. Track live in the app.`;
          await Message.create({
            schoolId: req.user.schoolId, senderId: req.user.id,
            receiverId: student.parent.id, tripId: trip.id,
            content, messageType: 'alert',
          });
          notifyUser(student.parent.id, 'trip-started', {
            tripId: trip.id, routeName: trip.route.name,
            driverName, studentName: student.firstName,
            message: content,
          });
        }
      }
    }

    // Broadcast trip-started to trip room
    notifyTrip(trip.id, 'trip-status', { tripId: trip.id, status: 'in_progress' });

    res.json({ message: 'Trip started. All parents notified.', trip });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.endTrip = async (req, res) => {
  try {
    const trip = await Trip.findByPk(req.params.id, { include: [{ model: Route, as: 'route', where: { schoolId: req.user.schoolId } }] });
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    if (trip.status !== 'in_progress') return res.status(400).json({ error: 'Trip not in progress.' });
    await trip.update({ status: 'completed', endedAt: new Date() });
    notifyTrip(trip.id, 'trip-status', { tripId: trip.id, status: 'completed' });
    res.json({ message: 'Trip completed.', trip });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.logAction = async (req, res) => {
  try {
    const { studentId, action, lat, lng, notes } = req.body;
    const trip = await Trip.findByPk(req.params.id, { include: [{ model: Route, as: 'route', where: { schoolId: req.user.schoolId }, include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','email'] }] }] }] });
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    const log = await TripLog.create({ tripId: trip.id, studentId, action, lat, lng, notes, timestamp: new Date() });

    if (trip.route && trip.route.students) {
      const pickedStudent = trip.route.students.find(s => s.id === studentId);

      if (action === 'arrived' && pickedStudent && pickedStudent.parent) {
        // Notify the parent that driver has arrived at their location
        const content = `🚌 The bus has arrived at your pickup location for ${pickedStudent.firstName}!`;
        await Message.create({
          schoolId: req.user.schoolId, senderId: req.user.id,
          receiverId: pickedStudent.parent.id, tripId: trip.id,
          content, messageType: 'arrival',
        });
        notifyUser(pickedStudent.parent.id, 'driver-arrived', {
          tripId: trip.id, studentName: pickedStudent.firstName, message: content,
        });
      }

      if (action === 'check_in' && pickedStudent) {
        // Notify this parent that their child was picked up
        if (pickedStudent.parent) {
          const pickupMsg = `✅ ${pickedStudent.firstName} has been picked up and is on the bus!`;
          await Message.create({
            schoolId: req.user.schoolId, senderId: req.user.id,
            receiverId: pickedStudent.parent.id, tripId: trip.id,
            content: pickupMsg, messageType: 'system',
          });
          notifyUser(pickedStudent.parent.id, 'student-picked-up', {
            tripId: trip.id, studentName: pickedStudent.firstName, message: pickupMsg,
          });
        }

        // Notify next 3 parents that the driver is approaching
        const pickedOrder = pickedStudent.RouteStudent.stopOrder;
        const upcomingStudents = trip.route.students
          .filter(s => s.RouteStudent.stopOrder > pickedOrder && s.parent)
          .sort((a, b) => a.RouteStudent.stopOrder - b.RouteStudent.stopOrder)
          .slice(0, 3);

        for (const upcoming of upcomingStudents) {
          const stopsAway = upcoming.RouteStudent.stopOrder - pickedOrder;
          const eta = estimateETA(stopsAway);
          const content = `🚌 Driver is approaching! ${stopsAway} stop${stopsAway > 1 ? 's' : ''} away from ${upcoming.firstName}'s pickup. ETA: ${eta.text}`;
          await Message.create({
            schoolId: req.user.schoolId, senderId: req.user.id,
            receiverId: upcoming.parent.id, tripId: trip.id,
            content, messageType: 'alert',
          });
          notifyUser(upcoming.parent.id, 'driver-approaching', {
            tripId: trip.id, studentName: upcoming.firstName,
            stopsAway, etaMinutes: eta.minutes, message: content,
          });
        }
      }
    }

    // Broadcast pickup event to trip room
    notifyTrip(trip.id, 'trip-log', { tripId: trip.id, studentId, action, lat, lng, timestamp: Date.now() });

    res.status(201).json({ message: `Student ${action} logged.`, log });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getTripLogs = async (req, res) => {
  try {
    const logs = await TripLog.findAll({ where: { tripId: req.params.id }, include: [{ model: Student, as: 'student', attributes: ['id','firstName','lastName','grade'] }], order: [['timestamp','ASC']] });
    res.json({ logs, total: logs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
