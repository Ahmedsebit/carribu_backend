const { sequelize, Student, User, ParentSchool, School, Route, RouteStudent, Trip } = require('../models');
const { Op } = require('sequelize');
const { getActiveParentSchoolIds } = require('../utils/parentSchoolAccess');
const { editableFields } = require('../utils/editableFields');
const { lockSchool, refreshFuturePlans } = require('../services/tripWorkflow');
const STUDENT_FIELDS = ['parentId', 'admissionNumber', 'firstName', 'lastName', 'grade', 'isActive'];
const {
  getRouteStart,
  replaceRouteStudentOrder,
} = require('../services/routeOrdering');

const validateParentLink = async (parentId, schoolId, transaction) => {
  if (parentId === null || parentId === undefined || parentId === '') return null;
  const parsedParentId = Number.parseInt(parentId, 10);
  if (!Number.isInteger(parsedParentId) || parsedParentId <= 0) {
    const error = new Error('Invalid parent.');
    error.status = 400;
    throw error;
  }
  const membership = await ParentSchool.findOne({
    transaction,
    where: { parentId: parsedParentId, schoolId, isActive: true },
    include: [{
      model: User,
      as: 'parent',
      where: { role: 'parent', isActive: true },
      attributes: ['id'],
      required: true,
    }],
  });
  if (!membership) {
    const error = new Error('Parent is not active in this school.');
    error.status = 400;
    throw error;
  }
  return parsedParentId;
};

async function updateStudent(req, updates) {
  if ('isActive' in updates && typeof updates.isActive !== 'boolean') {
    throw Object.assign(new Error('isActive must be a boolean.'), { status: 400 });
  }
  return sequelize.transaction(async transaction => {
    await lockSchool(req.user.schoolId, transaction);
    const student = await Student.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId },
      transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!student) throw Object.assign(new Error('Student not found.'), { status: 404 });
    if (updates.isActive === false) {
      const activeTrips = await Trip.findAll({
        where: { status: 'in_progress' },
        include: [{ model: Route, as: 'route', where: { schoolId: req.user.schoolId }, required: true }],
        transaction,
      });
      for (const trip of activeTrips) {
        const included = trip.plan
          ? trip.plan.stops.some(stop => stop.studentId === student.id)
          : await RouteStudent.findOne({ where: { routeId: trip.routeId, studentId: student.id }, transaction });
        if (included) throw Object.assign(new Error('Complete or safely cancel the active trip before deactivating this student.'), { status: 409 });
      }
    }
    if ('admissionNumber' in updates) {
      updates.admissionNumber = String(updates.admissionNumber || '').trim().toUpperCase();
      if (!updates.admissionNumber) throw Object.assign(new Error('Admission number is required.'), { status: 400 });
      const existing = await Student.findOne({
        where: { schoolId: req.user.schoolId, admissionNumber: { [Op.iLike]: updates.admissionNumber }, id: { [Op.ne]: student.id } },
        transaction,
      });
      if (existing) throw Object.assign(new Error('A student with this admission number already exists.'), { status: 409 });
    }
    if ('parentId' in updates) updates.parentId = await validateParentLink(updates.parentId, req.user.schoolId, transaction);
    const refreshPlans = ('isActive' in updates && updates.isActive !== student.isActive)
      || ('parentId' in updates && updates.parentId !== student.parentId);
    await student.update(updates, { transaction });
    if (refreshPlans) {
      const assignments = await RouteStudent.findAll({ where: { studentId: student.id }, transaction });
      await refreshFuturePlans(req.user.schoolId, {
        [Op.or]: [
          { routeId: { [Op.in]: assignments.map(assignment => assignment.routeId) } },
          { plan: { [Op.contains]: { stops: [{ studentId: student.id }] } } },
        ],
      }, transaction);
    }
    return student;
  });
}

exports.getAll = async (req, res) => {
  try {
    const activeSchoolIds = req.user.role === 'parent' ? await getActiveParentSchoolIds(req.user.id) : null;
    const where = req.user.role === 'parent'
      ? { parentId: req.user.id, schoolId: { [Op.in]: activeSchoolIds } }
      : { schoolId: req.user.schoolId };
    if (req.query.grade) where.grade = req.query.grade;
    if (req.user.role === 'parent' || req.query.status === 'active') where.isActive = true;
    else if (req.query.status === 'inactive') where.isActive = false;
    if (req.query.search) where[Op.or] = [
      { admissionNumber: { [Op.iLike]: `%${req.query.search}%` } },
      { firstName: { [Op.iLike]: `%${req.query.search}%` } },
      { lastName: { [Op.iLike]: `%${req.query.search}%` } },
    ];
    const students = await Student.findAll({ where, include: [
      { model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','email','pickupAddress','pickupLat','pickupLng'] },
      { model: School, as: 'school', attributes: ['id','name'] },
      { model: Route, as: 'routes', attributes: ['id','name'], through: { attributes: ['stopOrder'] } },
    ], order: [['firstName','ASC'],['lastName','ASC']] });
    res.json({ students, total: students.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getById = async (req, res) => {
  try {
    const activeSchoolIds = req.user.role === 'parent' ? await getActiveParentSchoolIds(req.user.id) : null;
    const where = req.user.role === 'parent'
      ? { id: req.params.id, parentId: req.user.id, schoolId: { [Op.in]: activeSchoolIds } }
      : { id: req.params.id, schoolId: req.user.schoolId };
    const student = await Student.findOne({ where, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','email','pickupAddress','pickupLat','pickupLng','dropoffAddress','dropoffLat','dropoffLng'] }, { model: Route, as: 'routes', through: { attributes: ['stopOrder'] } }] });
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    res.json({ student });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try {
    const data = editableFields(req.body, STUDENT_FIELDS);
    if ('isActive' in data && typeof data.isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean.' });
    }
    const admissionNumber = String(req.body.admissionNumber || '').trim().toUpperCase();
    if (!admissionNumber) return res.status(400).json({ error: 'Admission number is required.' });
    const existing = await Student.findOne({ where: { schoolId: req.user.schoolId, admissionNumber: { [Op.iLike]: admissionNumber } } });
    if (existing) return res.status(409).json({ error: 'A student with this admission number already exists.' });
    const parentId = await validateParentLink(req.body.parentId, req.user.schoolId);
    const student = await Student.create({
      ...data,
      parentId,
      admissionNumber,
      schoolId: req.user.schoolId,
    });
    res.status(201).json({ message: 'Student created.', student });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A student with this admission number already exists.' });
    res.status(err.status || 500).json({ error: err.message });
  }
};
exports.update = async (req, res) => {
  try {
    const updates = editableFields(req.body, STUDENT_FIELDS);
    const student = await updateStudent(req, updates);
    res.json({ message: 'Student updated.', student });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A student with this admission number already exists.' });
    res.status(err.status || 500).json({ error: err.message });
  }
};
exports.delete = async (req, res) => {
  try {
    await updateStudent(req, { isActive: false });
    res.json({ message: 'Student deactivated. Route assignments have been retained for reactivation.' });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.assignRoute = async (req, res) => {
  try {
    const { routeId } = req.body;
    await sequelize.transaction(async transaction => {
      await lockSchool(req.user.schoolId, transaction);
      const student = await Student.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId }, transaction });
      if (!student) throw Object.assign(new Error('Student not found.'), { status: 404 });
      const route = await Route.findOne({ where: { id: routeId, schoolId: req.user.schoolId }, transaction });
      if (!route) throw Object.assign(new Error('Route not found.'), { status: 404 });
      if (await Trip.count({ where: { routeId: route.id, status: 'in_progress' }, transaction })) {
        throw Object.assign(new Error('End the active trip before editing this route.'), { status: 409 });
      }
      await RouteStudent.findOrCreate({
        where: { routeId, studentId: student.id },
        defaults: { stopOrder: 0 },
        transaction,
      });
      const assignments = await RouteStudent.findAll({
        where: { routeId },
        order: [['stopOrder', 'ASC']],
        transaction,
      });
      await replaceRouteStudentOrder(
        routeId,
        assignments.map(assignment => assignment.studentId),
        await getRouteStart(routeId, transaction),
        req.user.schoolId,
        transaction
      );
      await refreshFuturePlans(req.user.schoolId, { routeId: route.id }, transaction);
    });
    res.json({ message: 'Student assigned to route.' });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
