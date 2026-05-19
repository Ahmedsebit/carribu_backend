const { Route, Vehicle, User, Student, RouteStudent } = require('../models');
exports.getAll = async (req, res) => {
  try {
    const routes = await Route.findAll({ where: { schoolId: req.user.schoolId }, include: [
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','capacity'] },
      { model: User, as: 'driver', attributes: ['id','firstName','lastName','phone'] },
      { model: Student, as: 'students', attributes: ['id','firstName','lastName','grade'], through: { attributes: ['stopOrder'] } },
    ], order: [['name','ASC']] });
    res.json({ routes, total: routes.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getById = async (req, res) => {
  try {
    const route = await Route.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId }, include: [
      { model: Vehicle, as: 'vehicle' },
      { model: User, as: 'driver', attributes: { exclude: ['passwordHash'] } },
      { model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone'] }] },
    ]});
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    res.json({ route });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.create = async (req, res) => {
  try {
    const route = await Route.create({ ...req.body, schoolId: req.user.schoolId });
    if (req.body.studentIds && req.body.studentIds.length > 0) {
      await RouteStudent.bulkCreate(req.body.studentIds.map((sid, i) => ({ routeId: route.id, studentId: sid, stopOrder: i + 1 })));
    }
    const full = await Route.findByPk(route.id, { include: [{ model: Vehicle, as: 'vehicle' }, { model: User, as: 'driver', attributes: { exclude: ['passwordHash'] } }, { model: Student, as: 'students', through: { attributes: ['stopOrder'] } }] });
    res.status(201).json({ message: 'Route created.', route: full });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.update = async (req, res) => {
  try {
    const route = await Route.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    await route.update(req.body);
    if (req.body.studentIds) {
      await RouteStudent.destroy({ where: { routeId: route.id } });
      await RouteStudent.bulkCreate(req.body.studentIds.map((sid, i) => ({ routeId: route.id, studentId: sid, stopOrder: i + 1 })));
    }
    res.json({ message: 'Route updated.', route });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.delete = async (req, res) => {
  try {
    const route = await Route.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId } });
    if (!route) return res.status(404).json({ error: 'Route not found.' });
    await route.update({ isActive: false }); res.json({ message: 'Route deactivated.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
