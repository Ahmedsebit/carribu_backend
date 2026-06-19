const crypto = require('crypto');
const { School, User, Vehicle, Student, Route, Trip } = require('../models');
const { Op } = require('sequelize');
const { sendPasswordResetEmail } = require('../utils/email');

const generatePassword = () => crypto.randomBytes(4).toString('hex');

// --- School Management ---

exports.createSchool = async (req, res) => {
  try {
    const { name, address, city, phone, email, logoUrl } = req.body;
    if (!name) return res.status(400).json({ error: 'School name is required.' });
    const school = await School.create({ name, address, city, phone, email, logoUrl, managedBy: req.user.id });
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
        { model: User, as: 'manager', attributes: ['id', 'firstName', 'lastName', 'email'] },
      ],
    });
    const result = schools.map(s => ({
      ...s.toJSON(),
      vehicleCount: s.vehicles.length,
      studentCount: s.students.length,
      routeCount: s.routes.length,
      adminCount: s.users.filter(u => u.role === 'school_admin').length,
      userCount: s.users.length,
      manager: s.manager,
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
        { model: Vehicle, as: 'vehicles', attributes: ['id', 'status'] },
        { model: User, as: 'users', attributes: ['id', 'role', 'isActive'] },
        { model: Student, as: 'students', attributes: ['id', 'isActive'] },
        { model: Route, as: 'routes', attributes: ['id', 'isActive'] },
        { model: User, as: 'manager', attributes: ['id', 'firstName', 'lastName', 'email'] },
      ],
    });
    if (!school) return res.status(404).json({ error: 'School not found.' });

    const result = {
      id: school.id,
      name: school.name,
      address: school.address,
      city: school.city,
      phone: school.phone,
      email: school.email,
      isActive: school.isActive,
      createdAt: school.createdAt,
      manager: school.manager,
      summary: {
        userCount: school.users.length,
        adminCount: school.users.filter(u => u.role === 'school_admin').length,
        driverCount: school.users.filter(u => u.role === 'driver').length,
        coordinatorCount: school.users.filter(u => u.role === 'coordinator').length,
        parentCount: school.users.filter(u => u.role === 'parent').length,
        studentCount: school.students.length,
        activeStudents: school.students.filter(s => s.isActive).length,
        vehicleCount: school.vehicles.length,
        activeVehicles: school.vehicles.filter(v => v.status === 'active').length,
        routeCount: school.routes.length,
        activeRoutes: school.routes.filter(r => r.isActive).length,
      },
    };
    res.json({ school: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateSchool = async (req, res) => {
  try {
    const school = await School.findByPk(req.params.id);
    if (!school) return res.status(404).json({ error: 'School not found.' });
    const { name, address, city, phone, email, logoUrl, isActive, managedBy } = req.body;
    await school.update({ name, address, city, phone, email, logoUrl, isActive, managedBy });
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

exports.resetAdminPassword = async (req, res) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.role !== 'school_admin') return res.status(400).json({ error: 'User is not a school admin.' });

    const newPassword = generatePassword();
    await user.update({ passwordHash: newPassword });

    const school = await School.findByPk(user.schoolId);
    const emailResult = await sendPasswordResetEmail(user.email, user.firstName, newPassword, school?.name || 'Your School');

    res.json({
      message: 'Admin password reset successfully.',
      tempPassword: newPassword,
      emailSent: emailResult.sent || false,
      previewUrl: emailResult.previewUrl || null,
    });
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
