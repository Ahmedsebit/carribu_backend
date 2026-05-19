const { Trip, TripLog, Route, Vehicle, User, Student, Message, RouteStudent } = require('../models');
exports.getAll = async (req, res) => {
  try {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.date) where.scheduledDate = req.query.date;
    const trips = await Trip.findAll({ where, include: [
      { model: Route, as: 'route', where: { schoolId: req.user.schoolId }, attributes: ['id','name'] },
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model'] },
      { model: User, as: 'driver', attributes: ['id','firstName','lastName'] },
    ], order: [['scheduled_date','DESC'],['created_at','DESC']] });
    res.json({ trips, total: trips.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try {
    const { routeId, type, scheduledDate } = req.body;
    const route = await Route.findOne({ where: { id: routeId, schoolId: req.user.schoolId } });
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    const trip = await Trip.create({ routeId, driverId: route.driverId, vehicleId: route.vehicleId, type, scheduledDate, status: 'scheduled' });
    res.status(201).json({ message: 'Trip scheduled.', trip });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.startTrip = async (req, res) => {
  try {
    const trip = await Trip.findByPk(req.params.id, { include: [{ model: Route, as: 'route', where: { schoolId: req.user.schoolId } }] });
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    if (trip.status !== 'scheduled') return res.status(400).json({ error: 'Trip already started or completed.' });
    await trip.update({ status: 'in_progress', startedAt: new Date() });
    res.json({ message: 'Trip started.', trip });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.endTrip = async (req, res) => {
  try {
    const trip = await Trip.findByPk(req.params.id, { include: [{ model: Route, as: 'route', where: { schoolId: req.user.schoolId } }] });
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    if (trip.status !== 'in_progress') return res.status(400).json({ error: 'Trip not in progress.' });
    await trip.update({ status: 'completed', endedAt: new Date() });
    res.json({ message: 'Trip completed.', trip });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.logAction = async (req, res) => {
  try {
    const { studentId, action, lat, lng, notes } = req.body;
    const trip = await Trip.findByPk(req.params.id, { include: [{ model: Route, as: 'route', where: { schoolId: req.user.schoolId }, include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','email'] }] }] }] });
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    const log = await TripLog.create({ tripId: trip.id, studentId, action, lat, lng, notes, timestamp: new Date() });

    // Notify parents of students coming AFTER this stop when a child is picked up
    if (action === 'check_in' && trip.route && trip.route.students) {
      const pickedStudent = trip.route.students.find(s => s.id === studentId);
      if (pickedStudent) {
        const pickedOrder = pickedStudent.RouteStudent.stopOrder;
        // Find students with higher stop order (coming after this pickup)
        const upcomingStudents = trip.route.students.filter(s =>
          s.RouteStudent.stopOrder > pickedOrder && s.parent && s.parent.id !== req.user.id
        );
        // Notify each parent that the bus picked up a student before theirs
        for (const upcoming of upcomingStudents) {
          const stopsAway = upcoming.RouteStudent.stopOrder - pickedOrder;
          const content = `🚌 Bus update: ${pickedStudent.firstName} was just picked up. Your child ${upcoming.firstName} is ${stopsAway} stop${stopsAway > 1 ? 's' : ''} away (~${stopsAway * 3} min).`;
          await Message.create({
            schoolId: req.user.schoolId,
            senderId: req.user.id,
            receiverId: upcoming.parent.id,
            tripId: trip.id,
            content,
            messageType: 'system',
          });
        }
      }
    }

    res.status(201).json({ message: `Student ${action} logged.`, log });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getTripLogs = async (req, res) => {
  try {
    const logs = await TripLog.findAll({ where: { tripId: req.params.id }, include: [{ model: Student, as: 'student', attributes: ['id','firstName','lastName','grade'] }], order: [['timestamp','ASC']] });
    res.json({ logs, total: logs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
