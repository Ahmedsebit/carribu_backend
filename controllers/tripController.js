const { Trip, TripLog, Route, Vehicle, User, Student, RouteStudent } = require('../models');
const { sequelize } = require('../models');
const { Op } = require('sequelize');
const {
  checkDelayedTrips,
  checkMissedTrips,
  schoolDate,
} = require('../services/tripReminders');
const { getAdminTripLocation, getLocationSource } = require('../services/locationTracking');
const workflow = require('../services/tripWorkflow');
const { getTripState } = require('../services/tripPlan');
const { getAccessibleTrip } = require('../services/tripAccess');
const { getReadyRoute } = require('../services/tripReadiness');

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
    attributes: ['id', 'type', 'scheduledDate', 'status', 'plan'],
    where,
    include: [{ model: TripLog, as: 'logs', include: [{ model: Student, as: 'student', attributes: ['id', 'firstName', 'lastName'] }] }, {
      model: Route,
      as: 'route',
      attributes: ['id', 'name'],
      required: true,
      where: { schoolId },
      include: [{
        model: Student,
        as: 'students',
        attributes: ['id', 'admissionNumber', 'firstName', 'lastName'],
        required: false,
        where: { id: { [Op.in]: studentIds } },
        through: { attributes: [] },
      }],
    }],
    transaction,
  });

  return trips.flatMap(conflictingTrip => {
    const frozen = conflictingTrip.plan && !['scheduled', 'delayed'].includes(conflictingTrip.status);
    const students = (frozen ? conflictingTrip.plan.stops : null) || (conflictingTrip.status === 'completed'
      ? getTripState(conflictingTrip, conflictingTrip.logs).pickupList
      : conflictingTrip.route.students.map(student => ({
      studentId: student.id, admissionNumber: student.admissionNumber, studentName: `${student.firstName} ${student.lastName}`,
    })));
    return students.filter(student => studentIds.includes(student.studentId)).map(student => ({
      studentId: student.studentId,
      admissionNumber: student.admissionNumber,
      studentName: student.studentName,
      tripId: conflictingTrip.id,
      routeName: conflictingTrip.route.name,
      type: conflictingTrip.type,
      scheduledDate: conflictingTrip.scheduledDate,
      status: conflictingTrip.status,
    }));
  });
}

async function findResourceConflicts(route, dates, scheduledTime, transaction) {
  if (!dates.length) return [];
  const trips = await Trip.findAll({
    where: {
      scheduledDate: { [Op.in]: dates }, scheduledTime,
      status: { [Op.in]: ['scheduled', 'delayed', 'in_progress'] },
      [Op.or]: [{ driverId: route.driverId }, { vehicleId: route.vehicleId }],
    },
    include: [{ model: Route, as: 'route', where: { schoolId: route.schoolId }, required: true }],
    transaction,
  });
  return trips.map(trip => ({
    tripId: trip.id, scheduledDate: trip.scheduledDate,
    routeName: trip.route.name, resourceConflict: true,
  }));
}

exports.getAll = async (req, res) => {
  try {
    // Refresh delayed/missed-trip state before listing so the admin dashboard
    // shows trips that passed their start time (delayed) or lapsed the grace
    // window without being started (missed / "not started").
    await checkDelayedTrips(Date.now());
    await checkMissedTrips(Date.now());
    const today = schoolDate();
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.date) {
      if (req.query.date === 'today' && req.query.includeActive === 'true') {
        where[Op.and] = [{ [Op.or]: [{ scheduledDate: today }, { status: 'in_progress' }] }];
      } else where.scheduledDate = req.query.date === 'today' ? today : req.query.date;
    } else if (req.query.startDate || req.query.endDate) {
      where.scheduledDate = {};
      if (req.query.startDate) where.scheduledDate[Op.gte] = req.query.startDate;
      if (req.query.endDate) where.scheduledDate[Op.lte] = req.query.endDate;
    }
    const studentId = Number.parseInt(req.query.studentId, 10);
    const studentFilter = Number.isInteger(studentId) && studentId > 0
      ? { id: studentId }
      : undefined;
    if (studentFilter) where[Op.or] = [
      { plan: { [Op.contains]: { stops: [{ studentId }] } } },
      { plan: null, '$route.students.id$': studentId },
    ];
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
          required: false,
          through: { attributes: ['stopOrder'] },
        }],
      },
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model'] },
      { model: User, as: 'driver', attributes: ['id','firstName','lastName'] },
      { model: TripLog, as: 'logs' },
    ], order: [['scheduled_date','DESC'],['created_at','DESC']] });
    const result = trips.filter(trip => trip.plan?.schoolId == null || trip.plan.schoolId === req.user.schoolId).map(trip => {
      const t = trip.toJSON();
      const state = getTripState(t);
      t.studentStats = state.stats;
      const upcoming = ['scheduled', 'delayed'].includes(t.status) && !t.startedAt;
      t.rosterSource = t.plan && !upcoming ? 'trip_plan' : ['completed', 'cancelled', 'missed'].includes(t.status) ? 'recorded_logs' : 'current_route';
      t.phase = state.phase;
      t.canEnd = state.canEnd;
      if (t.route) {
        t.route.name = (!upcoming && t.plan?.routeName) || t.route.name;
        t.route.students = state.pickupList.filter(s => !studentFilter || s.studentId === studentId).map(s => ({
          id: s.studentId, firstName: s.firstName, lastName: s.lastName, grade: s.grade,
          RouteStudent: { stopOrder: s.stopNumber },
        }));
      }
      delete t.logs;
      delete t.plan;
      return t;
    });
    res.json({ trips: result, total: result.length, schoolDate: today });
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
                  attributes: ['id', 'firstName', 'lastName', 'grade', 'isActive'],
                  through: { attributes: ['stopOrder'] },
                  include: [{
                    model: User,
                    as: 'parent',
                    attributes: ['id', 'firstName', 'lastName', 'phone', 'pickupAddress', 'pickupLat', 'pickupLng', 'dropoffAddress', 'dropoffLat', 'dropoffLng'],
                  }],
                }],
              },
              { model: Vehicle, as: 'vehicle', attributes: ['id', 'plateNumber', 'make', 'model', 'capacity', 'color', 'trackerUniqueId'] },
              { model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName', 'phone'] },
              {
                model: TripLog,
                as: 'logs',
                include: [
                  { model: Student, as: 'student', attributes: ['id', 'firstName', 'lastName', 'grade'] },
                  { model: User, as: 'recordedBy', attributes: ['id', 'firstName', 'lastName', 'role'] },
                ],
              },
            ],
            order: [
              [{ model: Route, as: 'route' }, { model: Student, as: 'students' }, RouteStudent, 'stop_order', 'ASC'],
              [{ model: TripLog, as: 'logs' }, 'timestamp', 'ASC'],
            ],
          });
          if (!trip) return res.status(404).json({ error: 'Trip not found.' });

          const value = trip.toJSON();
          if (value.plan?.schoolId != null && value.plan.schoolId !== req.user.schoolId) {
            return res.status(404).json({ error: 'Trip not found.' });
          }
          const logs = value.logs || [];
          const state = getTripState(value);
          const pickupList = state.pickupList.map(student => ({
            ...student,
            ...(['pending', 'arrived_pickup'].includes(student.status) ? student.pickup : student.dropoff),
          }));
          const waitValues = pickupList.filter(student => student.waitSeconds != null).map(student => student.waitSeconds);
          const completedStops = pickupList.filter(student => ['dropped_off', 'absent'].includes(student.status)).length;
          const latestLocation = await getAdminTripLocation(trip);

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
              rosterSource: value.plan && !['scheduled', 'delayed'].includes(value.status) ? 'trip_plan' : ['completed', 'cancelled', 'missed'].includes(value.status) ? 'recorded_logs' : 'current_route',
              route: value.route ? {
                id: value.route.id,
                name: (!['scheduled', 'delayed'].includes(value.status) && value.plan?.routeName) || value.route.name,
                type: value.route.type,
                departureTime: value.route.departureTime,
              } : null,
              vehicle: value.vehicle,
              locationSource: value.status === 'in_progress' && value.vehicle
                ? getLocationSource(value.vehicle) : latestLocation?.source || null,
              driver: value.driver,
              pickupList,
              currentStop: state.currentStop,
              nextStop: state.nextStop,
              phase: state.phase,
              canEnd: state.canEnd,
              logs,
              location: latestLocation,
              stats: {
                totalStudents: pickupList.length,
                completedStops,
                ...state.stats,
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
    if (typeof scheduledTime !== 'string' || !TIME_PATTERN.test(scheduledTime)) {
      return res.status(400).json({ error: 'A scheduled time in HH:mm format is required for every new trip.' });
    }
    const normalizedTime = `${scheduledTime.slice(0, 5)}:00`;

    if (!recurrence) {
      let conflicts = [];
      let trip = null;
      await sequelize.transaction(async transaction => {
        await sequelize.query('SELECT pg_advisory_xact_lock(:schoolId)', {
          replacements: { schoolId: req.user.schoolId },
          transaction,
        });
        const { route, plan, studentIds } = await getReadyRoute(routeId, req.user.schoolId, type, transaction);
        conflicts = await findDailyStudentConflicts({
          schoolId: req.user.schoolId,
          studentIds,
          type,
          dates: [scheduledDate],
          transaction,
        });
        conflicts.push(...await findResourceConflicts(route, [scheduledDate], normalizedTime, transaction));
        if (conflicts.length > 0) return;

        trip = await Trip.create({
          routeId,
          driverId: route.driverId,
          vehicleId: route.vehicleId,
          type,
          scheduledDate,
          scheduledTime: normalizedTime,
          notes: notes || null,
          status: 'scheduled',
          plan,
        }, { transaction });
      });

      if (conflicts.length > 0) {
        if (conflicts.some(conflict => conflict.resourceConflict)) {
          return res.status(409).json({ error: 'The driver or vehicle already has a trip at this scheduled time.', conflicts });
        }
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

    const result = await sequelize.transaction(async transaction => {
      await sequelize.query('SELECT pg_advisory_xact_lock(:schoolId)', {
        replacements: { schoolId: req.user.schoolId },
        transaction,
      });
      const { route, plan, studentIds } = await getReadyRoute(routeId, req.user.schoolId, type, transaction);
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
      const newDates = dates.filter(date => !existingDates.has(date));
      const conflicts = await findDailyStudentConflicts({
        schoolId: req.user.schoolId,
        studentIds,
        type,
        dates: newDates,
        transaction,
      });
      conflicts.push(...await findResourceConflicts(route, newDates, normalizedTime, transaction));
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
        plan,
      })), { transaction, returning: true });
      return { trips, skippedCount: dates.length - datesToCreate.length, conflicts };
    });

    const createdCount = result.trips.length;
    return res.status(createdCount ? 201 : 200).json({
      message: createdCount
        ? `${createdCount} recurring ${createdCount === 1 ? 'trip' : 'trips'} scheduled.`
        : result.conflicts.length
          ? 'No trips were scheduled because of student or resource conflicts.'
          : 'All matching trips were already scheduled.',
      trip: result.trips[0] || null,
      trips: result.trips,
      count: createdCount,
      skippedCount: result.skippedCount,
      conflicts: result.conflicts,
    });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.startTrip = async (req, res) => {
  try {
    const result = await workflow.startTrip(req.params.id, req.user);
    res.json({ message: 'Trip started. Parent notifications queued.', ...result });
  } catch (err) { workflowError(res, err); }
};
exports.endTrip = async (req, res) => {
  try {
    res.json({ message: 'Trip completed. Parent notifications queued.', ...await workflow.completeTrip(req.params.id, req.user) });
  } catch (err) { workflowError(res, err); }
};
exports.cancelTrip = async (req, res) => {
  try {
    res.json({ message: 'Trip cancelled. Parent notifications queued.', ...await workflow.cancelTrip(req.params.id, req.user) });
  } catch (err) { workflowError(res, err); }
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
    const result = await workflow.logStudentAction(req.params.id, req.user, req.body);
    res.status(result.duplicate ? 200 : 201).json({ message: 'Student action recorded.', ...result });
  } catch (err) { workflowError(res, err); }
};
exports.getNotifications = async (req, res) => {
  try { res.json(await workflow.notificationDiagnostics(req.params.id, req.user)); }
  catch (err) { workflowError(res, err); }
};

function workflowError(res, err) {
  if (!err.status) console.error('Trip workflow failed:', err);
  res.status(err.status || 500).json({
    error: err.status ? err.message : 'Unable to update the trip.',
    ...(err.conflicts && { conflicts: err.conflicts }),
    ...(err.unresolvedStudents && { unresolvedStudents: err.unresolvedStudents }),
    ...(err.conflictingTripId && { conflictingTripId: err.conflictingTripId }),
  });
}
exports.getTripLogs = async (req, res) => {
  try {
    const access = await getAccessibleTrip(req.params.id, req.user);
    if (!access) return res.status(404).json({ error: 'Trip not found.' });
    const where = { tripId: access.trip.id };
    if (access.studentIds) where.studentId = { [Op.in]: access.studentIds };
    const logs = await TripLog.findAll({
      where,
      include: [{
        model: Student, as: 'student', attributes: ['id','firstName','lastName','grade'],
        ...(req.user.role !== 'super_admin' && { where: { schoolId: access.trip.route.schoolId }, required: true }),
      }],
      order: [['timestamp','ASC']],
    });
    res.json({ logs, total: logs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
