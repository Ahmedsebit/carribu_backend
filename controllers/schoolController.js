const { School, User, Vehicle, Student, Route } = require('../models');
const { editableFields } = require('../utils/editableFields');
const SCHOOL_FIELDS = ['name', 'address', 'city', 'phone', 'email', 'logoUrl'];
const schoolIdForRequest = req => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1
    || (req.user.role !== 'super_admin' && id !== req.user.schoolId)) {
    throw Object.assign(new Error('School not found.'), { status: 404 });
  }
  return id;
};
exports.getAll = async (req, res) => {
  try {
    const where = req.user.role === 'super_admin' ? {} : { id: req.user.schoolId };
    const schools = await School.findAll({ where, include: [
      { model: Vehicle, as: 'vehicles', attributes: ['id'] },
      { model: Student, as: 'students', attributes: ['id'] },
      { model: Route, as: 'routes', attributes: ['id'] },
    ]});
    const result = schools.map(s => ({ ...s.toJSON(), vehicleCount: s.vehicles.length, studentCount: s.students.length, routeCount: s.routes.length, vehicles: undefined, students: undefined, routes: undefined }));
    res.json({ schools: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getById = async (req, res) => {
  try {
    const school = await School.findByPk(schoolIdForRequest(req), { include: [{ model: Vehicle, as: 'vehicles' }, { model: User, as: 'users', attributes: { exclude: ['passwordHash'] } }] });
    if (!school) return res.status(404).json({ error: 'School not found.' });
    res.json({ school });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try {
    const school = await School.create({ ...editableFields(req.body, SCHOOL_FIELDS), managedBy: req.user.id });
    res.status(201).json({ message: 'School created.', school });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.update = async (req, res) => {
  try {
    const school = await School.findByPk(schoolIdForRequest(req));
    if (!school) return res.status(404).json({ error: 'School not found.' });
    const fields = req.user.role === 'super_admin' ? [...SCHOOL_FIELDS, 'isActive', 'managedBy'] : SCHOOL_FIELDS;
    await school.update(editableFields(req.body, fields)); res.json({ message: 'School updated.', school });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.delete = async (req, res) => {
  try {
    const school = await School.findByPk(schoolIdForRequest(req));
    if (!school) return res.status(404).json({ error: 'School not found.' });
    await school.update({ isActive: false }); res.json({ message: 'School deactivated.' });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.getDashboard = async (req, res) => {
  try {
    const schoolId = schoolIdForRequest(req);
    const [vehicleCount, studentCount, routeCount, driverCount] = await Promise.all([
      Vehicle.count({ where: { schoolId, status: 'active' } }),
      Student.count({ where: { schoolId, isActive: true } }),
      Route.count({ where: { schoolId, isActive: true } }),
      User.count({ where: { schoolId, role: ['driver','coordinator'], isActive: true } }),
    ]);
    res.json({ dashboard: { schoolId: parseInt(schoolId), vehicleCount, studentCount, routeCount, driverCount } });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
