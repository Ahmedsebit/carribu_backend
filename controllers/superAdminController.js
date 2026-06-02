const { School, User, Vehicle, Student, Route, Trip } = require('../models');
const { Op } = require('sequelize');

// --- School Management ---

exports.createSchool = async (req, res) => {
  try {
    const { name, address, city, phone, email, logoUrl } = req.body;
    if (!name) return res.status(400).json({ error: 'School name is required.' });
    const school = await School.create({ name, address, city, phone, email, logoUrl });
    res.status(201).json({ message: 'School created.', school });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.listSchools = async (req, res) => {
  try {
    const { search, isActive } = req.query;
    const where = {};
    if (isActive !== undefined) where.isActive = isActive === 'true';
    if (search) where.name = { [Op.like]: `%${search}%` };

    const schools = await School.findAll({
      where,
      include: [
        { model: Vehicle, as: 'vehicles', attributes: ['id'] },
        { model: Student, as: 'students', attributes: ['id'] },
        { model: Route, as: 'routes', attributes: ['id'] },
        { model: User, as: 'users', attributes: ['id', 'role'] },
      ],
    });
    const result = schools.map(s => ({
      ...s.toJSON(),
      vehicleCount: s.vehicles.length,
      studentCount: s.students.length,
      routeCount: s.routes.length,
      adminCount: s.users.filter(u => u.role === 'school_admin').length,
      userCount: s.users.length,
      vehicles: undefined,
      students: undefined,
      routes: undefined,
      users: undefined,
    }));
    res.json({ schools: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getSchool = async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id, {
      include: [
        { model: Vehicle, as: 'vehicles' },
        { model: User, as: 'users', attributes: { exclude: ['passwordHash'] } },
        { model: Student, as: 'students' },
        { model: Route, as: 'routes' },
      ],
    });
    if (!school) return res.status(404).json({ error: 'School not found.' });
    res.json({ school });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateSchool = async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) return res.status(404).json({ error: 'School not found.' });
    const { name, address, city, phone, email, logoUrl, isActive } = req.body;
    await school.update({ name, address, city, phone, email, logoUrl, isActive });
    res.json({ message: 'School updated.', school });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deactivateSchool = async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) return res.status(404).json({ error: 'School not found.' });
    await school.update({ isActive: false });
    // Deactivate all users of this school
    await User.update({ isActive: false }, { where: { schoolId: school.id } });
    res.json({ message: 'School and all its users deactivated.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.activateSchool = async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) return res.status(404).json({ error: 'School not found.' });
    await school.update({ isActive: true });
    res.json({ message: 'School activated.', school });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// --- School Admin Management ---

exports.createSchoolAdmin = async (req, res) => {
  try {
    const { schoolId, email, password, firstName, lastName, phone } = req.body;
    if (!schoolId || !email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'schoolId, email, password, firstName, and lastName are required.' });
    }
    const school = await School.findByPk(schoolId);
    if (!school) return res.status(400).json({ error: 'Invalid school ID.' });
    if (await User.findOne({ where: { email } })) return res.status(400).json({ error: 'Email already registered.' });

    const user = await User.create({
      schoolId, email, passwordHash: password, firstName, lastName, role: 'school_admin', phone,
    });
    res.status(201).json({ message: 'School admin created.', user });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.listSchoolAdmins = async (req, res) => {
  try {
    const where = { role: 'school_admin' };
    if (req.query.schoolId) where.schoolId = req.query.schoolId;
    const admins = await User.findAll({
      where,
      attributes: { exclude: ['passwordHash'] },
      include: [{ model: School, as: 'school', attributes: ['id', 'name'] }],
    });
    res.json({ admins });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.removeSchoolAdmin = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role !== 'school_admin') return res.status(400).json({ error: 'User is not a school admin.' });
    await user.update({ isActive: false });
    res.json({ message: 'School admin deactivated.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// --- Platform Monitoring / Dashboard ---

exports.platformOverview = async (req, res) => {
  try {
    const [schoolCount, activeSchools, totalUsers, totalStudents, totalVehicles, totalRoutes, totalTrips, activeTrips] = await Promise.all([
      School.count(),
      School.count({ where: { isActive: true } }),
      User.count(),
      Student.count(),
      Vehicle.count(),
      Route.count(),
      Trip.count(),
      Trip.count({ where: { status: 'in_progress' } }),
    ]);
    res.json({
      overview: { schoolCount, activeSchools, totalUsers, totalStudents, totalVehicles, totalRoutes, totalTrips, activeTrips },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.schoolStats = async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) return res.status(404).json({ error: 'School not found.' });

    const schoolId = school.id;
    const [userCount, studentCount, vehicleCount, routeCount, tripCount, activeTrips, adminCount] = await Promise.all([
      User.count({ where: { schoolId } }),
      Student.count({ where: { schoolId } }),
      Vehicle.count({ where: { schoolId } }),
      Route.count({ where: { schoolId } }),
      Trip.count({ where: { '$route.school_id$': schoolId }, include: [{ model: Route, as: 'route', attributes: [] }] }),
      Trip.count({ where: { status: 'in_progress', '$route.school_id$': schoolId }, include: [{ model: Route, as: 'route', attributes: [] }] }),
      User.count({ where: { schoolId, role: 'school_admin' } }),
    ]);
    res.json({
      school: { id: school.id, name: school.name, isActive: school.isActive },
      stats: { userCount, studentCount, vehicleCount, routeCount, tripCount, activeTrips, adminCount },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
