const { Student, User, School, Route, RouteStudent } = require('../models');
const { Op } = require('sequelize');
exports.getAll = async (req, res) => {
  try {
    const where = req.user.role === 'parent' ? { parentId: req.user.id } : { schoolId: req.user.schoolId };
    if (req.query.grade) where.grade = req.query.grade;
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
    const where = req.user.role === 'parent'
      ? { id: req.params.id, parentId: req.user.id }
      : { id: req.params.id, schoolId: req.user.schoolId };
    const student = await Student.findOne({ where, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','email','pickupAddress','pickupLat','pickupLng','dropoffAddress','dropoffLat','dropoffLng'] }, { model: Route, as: 'routes', through: { attributes: ['stopOrder'] } }] });
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    res.json({ student });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try {
    const admissionNumber = String(req.body.admissionNumber || '').trim().toUpperCase();
    if (!admissionNumber) return res.status(400).json({ error: 'Admission number is required.' });
    const existing = await Student.findOne({ where: { schoolId: req.user.schoolId, admissionNumber: { [Op.iLike]: admissionNumber } } });
    if (existing) return res.status(409).json({ error: 'A student with this admission number already exists.' });
    const student = await Student.create({ ...req.body, admissionNumber, schoolId: req.user.schoolId });
    res.status(201).json({ message: 'Student created.', student });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A student with this admission number already exists.' });
    res.status(500).json({ error: err.message });
  }
};
exports.update = async (req, res) => {
  try {
    const student = await Student.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const updates = { ...req.body };
    if (Object.prototype.hasOwnProperty.call(updates, 'admissionNumber')) {
      updates.admissionNumber = String(updates.admissionNumber || '').trim().toUpperCase();
      if (!updates.admissionNumber) return res.status(400).json({ error: 'Admission number is required.' });
      const existing = await Student.findOne({
        where: { schoolId: req.user.schoolId, admissionNumber: { [Op.iLike]: updates.admissionNumber }, id: { [Op.ne]: student.id } },
      });
      if (existing) return res.status(409).json({ error: 'A student with this admission number already exists.' });
    }
    await student.update(updates); res.json({ message: 'Student updated.', student });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A student with this admission number already exists.' });
    res.status(500).json({ error: err.message });
  }
};
exports.delete = async (req, res) => {
  try {
    const student = await Student.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    await student.update({ isActive: false }); res.json({ message: 'Student deactivated.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.assignRoute = async (req, res) => {
  try {
    const { routeId, stopOrder } = req.body;
    const student = await Student.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    const route = await Route.findOne({ where: { id: routeId, schoolId: req.user.schoolId } });
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    await RouteStudent.findOrCreate({ where: { routeId, studentId: student.id }, defaults: { stopOrder: stopOrder || 0 } });
    res.json({ message: 'Student assigned to route.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
