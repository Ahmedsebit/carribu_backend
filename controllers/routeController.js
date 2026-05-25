const { Route, Vehicle, User, Student, RouteStudent } = require('../models');
const { Op } = require('sequelize');
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
      { model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','pickupAddress','pickupLat','pickupLng'] }] },
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

// Suggest students who match route criteria (grades + proximity to waypoints)
exports.suggestStudents = async (req, res) => {
  try {
    const { grades, waypoints, radiusKm } = req.body;
    const radius = radiusKm || 3; // default 3km radius

    // Get all students in this school with their parent's location
    const where = { schoolId: req.user.schoolId, isActive: true };
    const students = await Student.findAll({
      where,
      include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','pickupAddress','pickupLat','pickupLng'] }],
    });

    let suggested = students;

    // Filter by grades if provided
    if (grades && grades.length > 0) {
      suggested = suggested.filter(s => grades.includes(s.grade));
    }

    // Filter by proximity to waypoints if provided
    if (waypoints && waypoints.length > 0) {
      suggested = suggested.filter(s => {
        if (!s.parent?.pickupLat || !s.parent?.pickupLng) return false;
        const studentLat = parseFloat(s.parent.pickupLat);
        const studentLng = parseFloat(s.parent.pickupLng);
        // Check if student is within radius of any waypoint
        const minDist = Math.min(...waypoints.map(wp => haversineDistance(studentLat, studentLng, wp.lat, wp.lng)));
        s._distanceKm = minDist;
        return minDist <= radius;
      });
    }

    res.json({
      students: suggested.map(s => ({
        id: s.id,
        firstName: s.firstName,
        lastName: s.lastName,
        grade: s.grade,
        parentName: s.parent ? `${s.parent.firstName} ${s.parent.lastName}` : null,
        pickupAddress: s.parent?.pickupAddress,
        pickupLat: s.parent?.pickupLat ? parseFloat(s.parent.pickupLat) : null,
        pickupLng: s.parent?.pickupLng ? parseFloat(s.parent.pickupLng) : null,
        distanceKm: s._distanceKm || null,
      })),
      total: suggested.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// Haversine formula to calculate distance between two points in km
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
