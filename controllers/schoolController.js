const { School, User, Vehicle, Student, Route } = require('../models');
exports.getAll = async (req, res) => {
  try {
    const where = req.user.role !== 'super_admin' ? { id: req.user.schoolId } : {};
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
    const school = await School.findByPk(req.params.id, { include: [{ model: Vehicle, as: 'vehicles' }, { model: User, as: 'users', attributes: { exclude: ['passwordHash'] } }] });
    if (!school) return res.status(404).json({ error: 'School not found.' });
    res.json({ school });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try { const school = await School.create(req.body); res.status(201).json({ message: 'School created.', school }); }
  catch (err) { res.status(500).json({ error: err.message }); }
};
exports.update = async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) return res.status(404).json({ error: 'School not found.' });
    await school.update(req.body); res.json({ message: 'School updated.', school });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.delete = async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) return res.status(404).json({ error: 'School not found.' });
    await school.update({ isActive: false }); res.json({ message: 'School deactivated.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getDashboard = async (req, res) => {
  try {
    const schoolId = req.params.id;
    const [vehicleCount, studentCount, routeCount, driverCount] = await Promise.all([
      Vehicle.count({ where: { schoolId, status: 'active' } }),
      Student.count({ where: { schoolId, isActive: true } }),
      Route.count({ where: { schoolId, isActive: true } }),
      User.count({ where: { schoolId, role: ['driver','coordinator'], isActive: true } }),
    ]);
    res.json({ dashboard: { schoolId: parseInt(schoolId), vehicleCount, studentCount, routeCount, driverCount } });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
