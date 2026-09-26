const { Trip, TripLog, Route, Vehicle, User, Student, Message, RouteStudent, BusLocation } = require('../models');
const { sequelize } = require('../models');
const { Op } = require('sequelize');
const { notifyUser, notifyTrip } = require('../socket');
const {
  checkDelayedTrips,
  checkMissedTrips,
  START_WINDOW_MINUTES,
  isStartWindowEarly,
  isStartWindowLapsed,
} = require('../services/tripReminders');
const {
  getRouteStart,
  replaceRouteStudentOrder,
  sortStudentsForTrip,
} = require('../services/routeOrdering');
const { getActiveParentIdsForSchool } = require('../utils/parentSchoolAccess');

// Helper: calculate ETA based on stops away (avg 3 min per stop)
function estimateETA(stopsAway) {
  const minutes = stopsAway * 3;
  return { minutes, text: minutes <= 1 ? '~1 minute' : `~${minutes} minutes` };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

function parseDateOnly(value) {
  if (!DATE_PATTERN.test(value || '')) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function buildRecurringDates(startDate, endDate, frequency, weekdays = []) {
  const selectedWeekdays = new Set(weekdays);
  const dates = [];
  for (const date = new Date(startDate); date <= endDate; date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.getUTCDay();
    const isWeekday = day >= 1 && day <= 5;
    if (
      ((frequency === 'daily' || frequency === 'weekdays') && isWeekday) ||
      (frequency === 'weekly' && selectedWeekdays.has(day))
    ) {
      dates.push(formatDateOnly(date));
    }
  }
  return dates;
}

async function findDailyStudentConflicts({
  schoolId,
  studentIds,
  type,
  dates,
  excludeTripId,
  statuses = ['scheduled', 'delayed', 'in_progress', 'completed'],
  transaction,
}) {
  if (studentIds.length === 0 || dates.length === 0) return [];

  const where = {
    type,
    scheduledDate: { [Op.in]: dates },
    status: { [Op.in]: statuses },
  };
  if (excludeTripId) where.id = { [Op.ne]: excludeTripId };

  const trips = await Trip.findAll({
    attributes: ['id', 'type', 'scheduledDate', 'status'],
    where,
    include: [{
      model: Route,
      as: 'route',
      attributes: ['id', 'name'],
      required: true,
      where: { schoolId },
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

  return trips.flatMap(conflictingTrip =>
    conflictingTrip.route.students.map(student => ({
      studentId: student.id,
      admissionNumber: student.admissionNumber,
      studentName: `${student.firstName} ${student.lastName}`,
      tripId: conflictingTrip.id,
      routeName: conflictingTrip.route.name,
      type: conflictingTrip.type,
      scheduledDate: conflictingTrip.scheduledDate,
      status: conflictingTrip.status,
    }))
  );
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
    if (req.query.date) {
      where.scheduledDate = req.query.date;
    } else if (req.query.startDate || req.query.endDate) {
      where.scheduledDate = {};
      if (req.query.startDate) where.scheduledDate[Op.gte] = req.query.startDate;
      if (req.query.endDate) where.scheduledDate[Op.lte] = req.query.endDate;
    }
    const studentId = Number.parseInt(req.query.studentId, 10);
    const studentFilter = Number.isInteger(studentId) && studentId > 0
      ? { id: studentId }
      : undefined;
    const trips = await Trip.findAll({ where, include: [
      {
        model: Route,
        as: 'route',
        where: { schoolId: req.user.schoolId },
        attributes: ['id','name'],
        include: [{
          model: Student,
          as: 'students',
          where: studentFilter,
          required: !!studentFilter,
          through: { attributes: ['stopOrder'] },
        }],
      },
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
        let status = t.type === 'afternoon_dropoff' ? 'on_bus' : 'pending';
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
  } catch (err) {
    console.error('Failed to list trips:', err);
    res.status(500).json({ error: err.message });
  }
};

exports.getDetails = async (req, res) => {
        try {
          const trip = await Trip.findOne({
            where: { id: req.params.id },
            include: [
              {
                model: Route,
                as: 'route',
                where: { schoolId: req.user.schoolId },
                attributes: ['id', 'name', 'type', 'departureTime'],
                include: [{
                  model: Student,
                  as: 'students',
                  attributes: ['id', 'firstName', 'lastName', 'grade'],
                  through: { attributes: ['stopOrder'] },
                  include: [{
                    model: User,
                    as: 'parent',
                    attributes: ['id', 'firstName', 'lastName', 'phone', 'pickupAddress', 'pickupLat', 'pickupLng', 'dropoffAddress', 'dropoffLat', 'dropoffLng'],
                  }],
                }],
              },
              { model: Vehicle, as: 'vehicle', attributes: ['id', 'plateNumber', 'make', 'model', 'capacity', 'color'] },
              { model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName', 'phone'] },
              {
                model: TripLog,
                as: 'logs',
                include: [{ model: Student, as: 'student', attributes: ['id', 'firstName', 'lastName', 'grade'] }],
              },
            ],
            order: [
              [{ model: Route, as: 'route' }, { model: Student, as: 'students' }, RouteStudent, 'stop_order', 'ASC'],
              [{ model: TripLog, as: 'logs' }, 'timestamp', 'ASC'],
            ],
          });
          if (!trip) return res.status(404).json({ error: 'Trip not found.' });

          const value = trip.toJSON();
          const logs = value.logs || [];
          const students = sortStudentsForTrip(value.route?.students, value.type);
          const firstLog = (studentId, action) => logs.find(log => log.studentId === studentId && log.action === action);
          const pickupList = students.map((student, index) => {
            const arrived = firstLog(student.id, 'arrived');
            const picked = firstLog(student.id, 'check_in');
            const dropped = firstLog(student.id, 'check_out');
            const absent = firstLog(student.id, 'absent');
            let status = value.type === 'afternoon_dropoff' ? 'on_bus' : 'pending';
            if (absent) status = 'absent';
            else if (dropped) status = 'dropped_off';
            else if (picked) status = 'on_bus';
            else if (arrived) status = 'arrived';
            const waitSeconds = arrived && picked
              ? Math.max(0, Math.round((new Date(picked.timestamp) - new Date(arrived.timestamp)) / 1000))
              : null;
            const parent = student.parent;
            return {
              stopNumber: student.RouteStudent?.stopOrder || index + 1,
              studentId: student.id,
              studentName: `${student.firstName} ${student.lastName}`,
              grade: student.grade,
              parentName: parent ? `${parent.firstName} ${parent.lastName}` : null,
              parentPhone: parent?.phone || null,
              address: value.type === 'afternoon_dropoff'
                ? (parent?.dropoffAddress || parent?.pickupAddress || null)
                : (parent?.pickupAddress || null),
              lat: value.type === 'afternoon_dropoff'
                ? (parent?.dropoffLat || parent?.pickupLat || null)
                : (parent?.pickupLat || null),
              lng: value.type === 'afternoon_dropoff'
                ? (parent?.dropoffLng || parent?.pickupLng || null)
                : (parent?.pickupLng || null),
              status,
              arrivedAt: arrived?.timestamp || null,
              pickedAt: picked?.timestamp || null,
              droppedAt: dropped?.timestamp || null,
              waitSeconds,
            };
          });

          const actionableStatuses = value.type === 'afternoon_dropoff'
            ? ['on_bus', 'arrived']
            : ['pending', 'arrived'];
          const nextStop = pickupList.find(student => actionableStatuses.includes(student.status)) || null;
          const waitValues = pickupList.filter(student => student.waitSeconds != null).map(student => student.waitSeconds);
          const completedStops = pickupList.filter(student => ['on_bus', 'dropped_off', 'absent'].includes(student.status)).length;
          const latestLocation = await BusLocation.findOne({
            where: { tripId: trip.id },
            attributes: ['lat', 'lng', 'speed', 'heading', 'recordedAt'],
            order: [['recorded_at', 'DESC']],
          });

          res.json({
            trip: {
              id: value.id,
              scheduledDate: value.scheduledDate,
              scheduledTime: value.scheduledTime,
              type: value.type,
              status: value.status,
              startedAt: value.startedAt,
              endedAt: value.endedAt,
              notes: value.notes,
              route: value.route ? {
                id: value.route.id,
                name: value.route.name,
                type: value.route.type,
                departureTime: value.route.departureTime,
              } : null,
              vehicle: value.vehicle,
              driver: value.driver,
              pickupList,
              nextStop,
              logs,
              location: latestLocation ? {
                lat: parseFloat(latestLocation.lat),
                lng: parseFloat(latestLocation.lng),
                speed: latestLocation.speed == null ? null : parseFloat(latestLocation.speed),
                heading: latestLocation.heading == null ? null : parseFloat(latestLocation.heading),
                recordedAt: latestLocation.recordedAt,
              } : null,
              stats: {
                totalStudents: pickupList.length,
                completedStops,
                pending: pickupList.filter(student => student.status === 'pending').length,
                arrived: pickupList.filter(student => student.status === 'arrived').length,
                onBus: pickupList.filter(student => student.status === 'on_bus').length,
                droppedOff: pickupList.filter(student => student.status === 'dropped_off').length,
                absent: pickupList.filter(student => student.status === 'absent').length,
                completionRate: pickupList.length ? Math.round((completedStops / pickupList.length) * 100) : 0,
                averageWaitSeconds: waitValues.length
                  ? Math.round(waitValues.reduce((sum, seconds) => sum + seconds, 0) / waitValues.length)
                  : null,
                durationMinutes: value.startedAt && value.endedAt
                  ? Math.max(0, Math.round((new Date(value.endedAt) - new Date(value.startedAt)) / 60000))
                  : null,
              },
            },
          });
        } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try {
    const { routeId, type, scheduledDate, scheduledTime, notes, recurrence } = req.body;
    const startDate = parseDateOnly(scheduledDate);
    if (!startDate) return res.status(400).json({ error: 'A valid scheduled date is required.' });
    if (!['morning_pickup', 'afternoon_dropoff'].includes(type)) {
      return res.status(400).json({ error: 'A valid trip type is required.' });
    }
    if (scheduledTime && !TIME_PATTERN.test(scheduledTime)) {
      return res.status(400).json({ error: 'Scheduled time must use HH:mm format.' });
    }

    const route = await Route.findOne({
      where: { id: routeId, schoolId: req.user.schoolId },
      include: [{
        model: Student,
        as: 'students',
        attributes: ['id'],
        through: { attributes: [] },
      }],
    });
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    const studentIds = route.students.map(student => student.id);

    if (!recurrence) {
      let conflicts = [];
      let trip = null;
      await sequelize.transaction(async transaction => {
        await sequelize.query('SELECT pg_advisory_xact_lock(:schoolId)', {
          replacements: { schoolId: req.user.schoolId },
          transaction,
        });
        conflicts = await findDailyStudentConflicts({
          schoolId: req.user.schoolId,
          studentIds,
          type,
          dates: [scheduledDate],
          transaction,
        });
        if (conflicts.length > 0) return;

        trip = await Trip.create({
          routeId,
          driverId: route.driverId,
          vehicleId: route.vehicleId,
          type,
          scheduledDate,
          scheduledTime: scheduledTime ? `${scheduledTime.slice(0, 5)}:00` : null,
          notes: notes || null,
          status: 'scheduled',
        }, { transaction });
      });

      if (conflicts.length > 0) {
        const names = [...new Set(conflicts.map(conflict => conflict.studentName))];
        const direction = type === 'morning_pickup' ? 'pickup' : 'drop-off';
        return res.status(409).json({
          error: `${names.join(', ')} ${names.length === 1 ? 'already has' : 'already have'} a ${direction} trip scheduled on ${scheduledDate}.`,
          conflicts,
        });
      }
      return res.status(201).json({ message: 'Trip scheduled.', trip, trips: [trip], count: 1, skippedCount: 0 });
    }

    const frequency = recurrence.frequency;
    if (!['daily', 'weekdays', 'weekly'].includes(frequency)) {
      return res.status(400).json({ error: 'Recurrence must be daily, weekdays, or weekly.' });
    }
    if (!scheduledTime) return res.status(400).json({ error: 'A scheduled time is required for recurring trips.' });

    const endDate = parseDateOnly(recurrence.endDate);
    if (!endDate) return res.status(400).json({ error: 'A valid recurrence end date is required.' });
    if (endDate < startDate) return res.status(400).json({ error: 'Recurrence end date cannot be before the start date.' });
    const rangeDays = Math.round((endDate - startDate) / 86400000);
    if (rangeDays > 365) return res.status(400).json({ error: 'Recurring trips can be scheduled for at most one year.' });

    const weekdays = [...new Set(
      (Array.isArray(recurrence.weekdays) ? recurrence.weekdays : [])
        .map(Number)
        .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    )];
    if (frequency === 'weekly' && weekdays.length === 0) {
      return res.status(400).json({ error: 'Select at least one weekday for a weekly schedule.' });
    }

    const dates = buildRecurringDates(startDate, endDate, frequency, weekdays);
    if (dates.length === 0) return res.status(400).json({ error: 'The recurrence pattern does not contain any trip dates.' });

    const normalizedTime = `${scheduledTime.slice(0, 5)}:00`;
    const result = await sequelize.transaction(async transaction => {
      await sequelize.query('SELECT pg_advisory_xact_lock(:schoolId)', {
        replacements: { schoolId: req.user.schoolId },
        transaction,
      });
      const existing = await Trip.findAll({
        attributes: ['scheduledDate'],
        where: {
          routeId: route.id,
          type,
          scheduledDate: { [Op.in]: dates },
          scheduledTime: normalizedTime,
        },
        transaction,
      });
      const existingDates = new Set(existing.map(trip => trip.scheduledDate));
      const conflicts = await findDailyStudentConflicts({
        schoolId: req.user.schoolId,
        studentIds,
        type,
        dates,
        transaction,
      });
      const conflictingDates = new Set(conflicts.map(conflict => conflict.scheduledDate));
      const datesToCreate = dates.filter(date =>
        !existingDates.has(date) && !conflictingDates.has(date)
      );
      const trips = await Trip.bulkCreate(datesToCreate.map(date => ({
        routeId: route.id,
        driverId: route.driverId,
        vehicleId: route.vehicleId,
        type,
        scheduledDate: date,
        scheduledTime: normalizedTime,
        notes: notes || null,
        status: 'scheduled',
      })), { transaction, returning: true });
      return { trips, skippedCount: dates.length - datesToCreate.length, conflicts };
    });

    const createdCount = result.trips.length;
    return res.status(createdCount ? 201 : 200).json({
      message: createdCount
        ? `${createdCount} recurring ${createdCount === 1 ? 'trip' : 'trips'} scheduled.`
        : 'All matching trips were already scheduled.',
      trip: result.trips[0] || null,
      trips: result.trips,
      count: createdCount,
      skippedCount: result.skippedCount,
      conflicts: result.conflicts,
    });
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
    if (isStartWindowEarly(trip)) {
      return res.status(400).json({ error: `This trip can only be started within ${START_WINDOW_MINUTES} minutes of its scheduled time.` });
    }
    // Guard the race where the start window lapsed since the last sweep.
    if (isStartWindowLapsed(trip)) {
      await trip.update({ status: 'missed' });
      return res.status(400).json({ error: `This trip was missed — it was not started within ${START_WINDOW_MINUTES} minutes after its scheduled time.` });
    }
    const currentStudents = [...(trip.route?.students || [])].sort(
      (left, right) =>
        (left.RouteStudent?.stopOrder || 0) - (right.RouteStudent?.stopOrder || 0)
    );
    const studentIds = currentStudents.map(student => student.id);
    await replaceRouteStudentOrder(
      trip.routeId,
      studentIds,
      await getRouteStart(trip.routeId),
      req.user.schoolId
    );
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
        const conflictingTrips = await Trip.findAll({
          attributes: ['id', 'type', 'scheduledDate', 'status'],
          where: {
            id: { [Op.ne]: trip.id },
            [Op.or]: [
              { status: 'in_progress' },
              {
                status: 'completed',
                type: trip.type,
                scheduledDate: trip.scheduledDate,
              },
            ],
          },
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

        conflicts = conflictingTrips.flatMap(conflictingTrip =>
          conflictingTrip.route.students.map(student => ({
            studentId: student.id,
            admissionNumber: student.admissionNumber,
            studentName: `${student.firstName} ${student.lastName}`,
            activeTripId: conflictingTrip.status === 'in_progress' ? conflictingTrip.id : null,
            conflictingTripId: conflictingTrip.id,
            conflictingRouteName: conflictingTrip.route.name,
            conflictingTripType: conflictingTrip.type,
            conflictingTripDate: conflictingTrip.scheduledDate,
            conflictingTripStatus: conflictingTrip.status,
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
      const hasCompletedDailyConflict = conflicts.some(conflict =>
        conflict.conflictingTripStatus === 'completed'
      );
      return res.status(409).json({
        error: hasCompletedDailyConflict
          ? `Trip cannot start because ${names.join(', ')} already completed this ${trip.type === 'morning_pickup' ? 'pickup' : 'drop-off'} on ${trip.scheduledDate}.`
          : `Trip cannot start because ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} already assigned to an active trip.`,
        conflicts,
      });
    }

    // Notify all parents on this route that the trip has started
    if (trip.route && trip.route.students) {
      const driverName = trip.driver ? `${trip.driver.firstName} ${trip.driver.lastName}` : 'Your driver';
      const activeParentIds = await getActiveParentIdsForSchool(
        trip.route.students.map(student => student.parent?.id),
        req.user.schoolId
      );
      for (const student of trip.route.students) {
        if (student.parent && activeParentIds.has(student.parent.id)) {
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
exports.delete = async (req, res) => {
  try {
    const trip = await Trip.findByPk(req.params.id, { include: [{ model: Route, as: 'route', where: { schoolId: req.user.schoolId }, attributes: [] }] });
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    if (trip.status === 'in_progress') {
      return res.status(409).json({ error: 'This trip is in progress. End the trip before deleting it.' });
    }
    await trip.destroy();
    res.json({ message: 'Trip deleted.' });
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
      const activeParentIds = await getActiveParentIdsForSchool(
        trip.route.students.map(student => student.parent?.id),
        req.user.schoolId
      );

      if (action === 'arrived' && pickedStudent && pickedStudent.parent && activeParentIds.has(pickedStudent.parent.id)) {
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
        if (pickedStudent.parent && activeParentIds.has(pickedStudent.parent.id)) {
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
          .filter(s => s.RouteStudent.stopOrder > pickedOrder && s.parent && activeParentIds.has(s.parent.id))
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
