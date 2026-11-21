const { Op } = require('sequelize');
const { sequelize, AbsenceRequest, Student, User, Trip, TripLog, Route } = require('../models');
const { getTripState } = require('../services/tripPlan');
const { withTrip, recordStudentAction, lockSchool } = require('../services/tripWorkflow');

const fail = (status, message) => Object.assign(new Error(message), { status });
const requestId = req => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw fail(400, 'A valid absence request ID is required.');
  return id;
};
const reviewNotes = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) {
    throw fail(400, 'An explanatory review note of at most 2000 characters is required.');
  }
  return value.trim();
};

exports.getAll = async (req, res) => {
  try {
    const where = { schoolId: req.user.schoolId };
    if (req.query.status) {
      if (!['pending', 'confirmed', 'rejected'].includes(req.query.status)) throw fail(400, 'Invalid review status.');
      where.status = req.query.status;
    }
    if (req.query.date) {
      const parsed = new Date(`${req.query.date}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(req.query.date) || !Number.isFinite(parsed.getTime())
        || parsed.toISOString().slice(0, 10) !== req.query.date) throw fail(400, 'Invalid date.');
      where.date = req.query.date;
    }
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = 30;
    const { rows, count } = await AbsenceRequest.findAndCountAll({
      where, limit, offset: (page - 1) * limit, order: [['createdAt', 'DESC'], ['id', 'DESC']],
      include: [
        { model: Student, as: 'student', attributes: ['id', 'firstName', 'lastName', 'grade', 'isActive', 'parentId'] },
        { model: User, as: 'parent', attributes: ['id', 'firstName', 'lastName'] },
        { model: User, as: 'reviewedBy', attributes: ['id', 'firstName', 'lastName'] },
      ],
    });
    const trips = rows.length ? await Trip.findAll({
      where: { status: 'in_progress', scheduledDate: { [Op.in]: [...new Set(rows.map(row => row.date))] } },
      include: [
        { model: Route, as: 'route', where: { schoolId: req.user.schoolId }, required: true, include: [{ model: Student, as: 'students' }] },
        { model: TripLog, as: 'logs' },
      ],
    }) : [];
    const requests = rows.map(row => {
      const request = row.toJSON();
      const matchingTrips = trips.filter(trip => trip.scheduledDate === request.date).flatMap(trip => {
        const student = getTripState(trip).pickupList.find(stop => stop.studentId === request.studentId);
        const parentMatches = request.student?.parentId === request.parentId && student?.parentId === request.parentId;
        return student ? [{
          id: trip.id, routeName: trip.route.name, type: trip.type, studentStatus: student.status,
          confirmed: request.confirmedTripIds.includes(trip.id),
          parentMatches,
          canConfirm: request.status !== 'rejected' && request.student?.isActive
            && parentMatches && ['pending', 'arrived_pickup', 'absent'].includes(student.status),
        }] : [];
      });
      return { ...request, matchingTrips };
    });
    res.json({ requests, total: count, page, pages: Math.max(1, Math.ceil(count / limit)) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};

exports.confirm = async (req, res) => {
  try {
    const id = requestId(req);
    const notes = reviewNotes(req.body.notes);
    const tripId = Number(req.body.tripId);
    if (!Number.isSafeInteger(tripId) || tripId <= 0) throw fail(400, 'A valid tripId is required.');
    const result = await withTrip(tripId, req.user, async (trip, route, transaction) => {
      const request = await AbsenceRequest.findOne({
        where: { id, schoolId: req.user.schoolId }, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!request) throw fail(404, 'Absence request not found.');
      if (trip.scheduledDate !== request.date) throw fail(409, 'This trip is not on the requested absence date.');
      if (request.status === 'rejected') throw fail(409, 'This request has been rejected.');
      if (request.confirmedTripIds.includes(trip.id)) return { request, duplicate: true };
      if (trip.status !== 'in_progress') throw fail(409, 'Select an active trip to confirm this attendance outcome.');
      const child = await Student.findOne({
        where: { id: request.studentId, schoolId: req.user.schoolId, parentId: request.parentId, isActive: true }, transaction,
      });
      if (!child) throw fail(409, 'Student or parent access has changed. Review the request before reconciling attendance.');
      const action = await recordStudentAction(trip, route, req.user, {
        studentId: request.studentId, action: 'absent', phase: 'pickup',
        expectedParentId: request.parentId,
        notes: `Absence request #${request.id}: ${notes}`,
        idempotencyKey: `absence:${request.id}:trip:${trip.id}`,
      }, transaction);
      await request.update({
        status: 'confirmed', confirmedTripIds: [...request.confirmedTripIds, trip.id],
        reviewedById: req.user.id, reviewedAt: new Date(), reviewNotes: notes,
      }, { transaction });
      return { request, duplicate: action.duplicate };
    });
    res.json({ message: 'Absence recorded for the selected trip only.', ...result });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};

exports.reject = async (req, res) => {
  try {
    const id = requestId(req);
    const notes = reviewNotes(req.body.notes);
    const request = await sequelize.transaction(async transaction => {
      await lockSchool(req.user.schoolId, transaction);
      const request = await AbsenceRequest.findOne({
        where: { id, schoolId: req.user.schoolId }, transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!request) throw fail(404, 'Absence request not found.');
      if (request.status === 'rejected') return request;
      if (request.confirmedTripIds.length) throw fail(409, 'A request with recorded attendance cannot be rejected.');
      await request.update({ status: 'rejected', reviewedById: req.user.id, reviewedAt: new Date(), reviewNotes: notes }, { transaction });
      return request;
    });
    res.json({ message: 'Request rejected. No attendance was changed.', request });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
