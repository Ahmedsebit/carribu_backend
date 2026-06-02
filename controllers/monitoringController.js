const { Op, fn, col, literal } = require('sequelize');
const { School, User, Vehicle, Student, Route, Trip, TripLog, AuditLog, Subscription, sequelize } = require('../models');

// --- Activity & Operations ---

exports.recentTrips = async (req, res) => {
  try {
    const { schoolId, status, limit = 20, offset = 0 } = req.query;
    const where = {};
    if (status) where.status = status;

    const include = [
      { model: Route, as: 'route', attributes: ['id', 'name', 'school_id'], include: [{ model: School, as: 'school', attributes: ['id', 'name'] }] },
      { model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName'] },
    ];

    if (schoolId) {
      include[0].where = { school_id: schoolId };
    }

    const { count, rows: trips } = await Trip.findAndCountAll({
      where,
      include,
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json({ trips, total: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.activeTrips = async (req, res) => {
  try {
    const trips = await Trip.findAll({
      where: { status: 'in_progress' },
      include: [
        { model: Route, as: 'route', attributes: ['id', 'name', 'school_id'], include: [{ model: School, as: 'school', attributes: ['id', 'name'] }] },
        { model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName', 'phone'] },
        { model: Vehicle, as: 'vehicle', attributes: ['id', 'plateNumber', 'make', 'model'] },
      ],
      order: [['startedAt', 'DESC']],
    });
    res.json({ activeTrips: trips, count: trips.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.tripHistory = async (req, res) => {
  try {
    const { schoolId, startDate, endDate, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (startDate || endDate) {
      where.scheduledDate = {};
      if (startDate) where.scheduledDate[Op.gte] = startDate;
      if (endDate) where.scheduledDate[Op.lte] = endDate;
    }

    const include = [
      { model: Route, as: 'route', attributes: ['id', 'name', 'school_id'], include: [{ model: School, as: 'school', attributes: ['id', 'name'] }] },
      { model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName'] },
    ];

    if (schoolId) {
      include[0].where = { school_id: schoolId };
    }

    const { count, rows: trips } = await Trip.findAndCountAll({
      where,
      include,
      order: [['scheduledDate', 'DESC'], ['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    const statusCounts = await Trip.findAll({
      where,
      attributes: ['status', [fn('COUNT', col('id')), 'count']],
      group: ['status'],
      raw: true,
    });

    res.json({ trips, total: count, statusBreakdown: statusCounts });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// --- Growth & Trends ---

exports.growthMetrics = async (req, res) => {
  try {
    const { period = '30' } = req.query;
    const daysAgo = new Date();
    daysAgo.setDate(daysAgo.getDate() - parseInt(period));

    const [newStudents, newUsers, newSchools, newTrips] = await Promise.all([
      Student.count({ where: { createdAt: { [Op.gte]: daysAgo } } }),
      User.count({ where: { createdAt: { [Op.gte]: daysAgo } } }),
      School.count({ where: { createdAt: { [Op.gte]: daysAgo } } }),
      Trip.count({ where: { createdAt: { [Op.gte]: daysAgo } } }),
    ]);

    // Previous period for comparison
    const prevStart = new Date(daysAgo);
    prevStart.setDate(prevStart.getDate() - parseInt(period));

    const [prevStudents, prevUsers, prevSchools, prevTrips] = await Promise.all([
      Student.count({ where: { createdAt: { [Op.between]: [prevStart, daysAgo] } } }),
      User.count({ where: { createdAt: { [Op.between]: [prevStart, daysAgo] } } }),
      School.count({ where: { createdAt: { [Op.between]: [prevStart, daysAgo] } } }),
      Trip.count({ where: { createdAt: { [Op.between]: [prevStart, daysAgo] } } }),
    ]);

    const calcGrowth = (current, previous) => previous === 0 ? (current > 0 ? 100 : 0) : Math.round(((current - previous) / previous) * 100);

    res.json({
      period: `${period} days`,
      current: { newStudents, newUsers, newSchools, newTrips },
      previous: { newStudents: prevStudents, newUsers: prevUsers, newSchools: prevSchools, newTrips: prevTrips },
      growth: {
        students: calcGrowth(newStudents, prevStudents),
        users: calcGrowth(newUsers, prevUsers),
        schools: calcGrowth(newSchools, prevSchools),
        trips: calcGrowth(newTrips, prevTrips),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.schoolGrowth = async (req, res) => {
  try {
    const schools = await School.findAll({
      attributes: ['id', 'name', 'createdAt'],
      include: [
        { model: Student, as: 'students', attributes: ['id', 'createdAt'] },
        { model: User, as: 'users', attributes: ['id', 'createdAt', 'role'] },
        { model: Vehicle, as: 'vehicles', attributes: ['id', 'createdAt'] },
      ],
    });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = schools.map(s => ({
      id: s.id,
      name: s.name,
      totalStudents: s.students.length,
      totalUsers: s.users.length,
      totalVehicles: s.vehicles.length,
      newStudentsLast30Days: s.students.filter(st => new Date(st.createdAt) >= thirtyDaysAgo).length,
      newUsersLast30Days: s.users.filter(u => new Date(u.createdAt) >= thirtyDaysAgo).length,
    }));

    res.json({ schools: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// --- Alerts & Health ---

exports.alerts = async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    // Schools with no recent trips (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const allSchools = await School.findAll({ where: { isActive: true }, attributes: ['id', 'name'] });
    const schoolsWithTrips = await Trip.findAll({
      where: { createdAt: { [Op.gte]: sevenDaysAgo } },
      include: [{ model: Route, as: 'route', attributes: ['school_id'] }],
      attributes: [],
      raw: true,
    });
    const activeSchoolIds = [...new Set(schoolsWithTrips.map(t => t['route.school_id']))];
    const idleSchools = allSchools.filter(s => !activeSchoolIds.includes(s.id));

    // Vehicles with expired or expiring insurance
    const expiredInsurance = await Vehicle.findAll({
      where: { status: 'active', insuranceExpiry: { [Op.lte]: today } },
      attributes: ['id', 'plateNumber', 'insuranceExpiry', 'schoolId'],
      include: [{ model: School, as: 'school', attributes: ['id', 'name'] }],
    });

    const expiringInsurance = await Vehicle.findAll({
      where: { status: 'active', insuranceExpiry: { [Op.between]: [today, thirtyDaysFromNow.toISOString().split('T')[0]] } },
      attributes: ['id', 'plateNumber', 'insuranceExpiry', 'schoolId'],
      include: [{ model: School, as: 'school', attributes: ['id', 'name'] }],
    });

    // Schools with no admin
    const schoolsWithAdmins = await User.findAll({
      where: { role: 'school_admin', isActive: true },
      attributes: ['schoolId'],
      raw: true,
    });
    const schoolIdsWithAdmin = [...new Set(schoolsWithAdmins.map(u => u.schoolId))];
    const schoolsWithoutAdmin = allSchools.filter(s => !schoolIdsWithAdmin.includes(s.id));

    res.json({
      alerts: {
        idleSchools: { count: idleSchools.length, schools: idleSchools },
        expiredInsurance: { count: expiredInsurance.length, vehicles: expiredInsurance },
        expiringInsurance: { count: expiringInsurance.length, vehicles: expiringInsurance },
        schoolsWithoutAdmin: { count: schoolsWithoutAdmin.length, schools: schoolsWithoutAdmin },
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// --- Audit & Usage ---

exports.auditLogs = async (req, res) => {
  try {
    const { userId, schoolId, action, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (userId) where.userId = userId;
    if (schoolId) where.schoolId = schoolId;
    if (action) where.action = { [Op.like]: `%${action}%` };

    const { count, rows: logs } = await AuditLog.findAndCountAll({
      where,
      include: [
        { model: User, as: 'user', attributes: ['id', 'firstName', 'lastName', 'email', 'role'] },
        { model: School, as: 'school', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
    res.json({ logs, total: count });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.recentLogins = async (req, res) => {
  try {
    const { limit = 50, schoolId } = req.query;
    const where = { action: { [Op.in]: ['login_success', 'login_failed'] } };
    if (schoolId) where.schoolId = schoolId;

    const logs = await AuditLog.findAll({
      where,
      include: [{ model: User, as: 'user', attributes: ['id', 'firstName', 'lastName', 'email', 'role'] }],
      order: [['createdAt', 'DESC']],
      limit: parseInt(limit),
    });
    res.json({ logins: logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// --- Financial / Subscriptions ---

exports.subscriptions = async (req, res) => {
  try {
    const { status } = req.query;
    const where = {};
    if (status) where.status = status;

    const subs = await Subscription.findAll({
      where,
      include: [{ model: School, as: 'school', attributes: ['id', 'name', 'isActive'] }],
      order: [['endDate', 'ASC']],
    });
    res.json({ subscriptions: subs });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.schoolUsage = async (req, res) => {
  try {
    const schools = await School.findAll({
      where: { isActive: true },
      attributes: ['id', 'name'],
      include: [
        { model: Student, as: 'students', attributes: ['id'] },
        { model: Vehicle, as: 'vehicles', attributes: ['id'] },
        { model: Subscription, as: 'subscription', attributes: ['plan', 'status', 'maxStudents', 'maxVehicles', 'endDate'] },
      ],
    });

    const usage = schools.map(s => {
      const sub = s.subscription;
      return {
        schoolId: s.id,
        schoolName: s.name,
        students: { current: s.students.length, max: sub?.maxStudents || null, utilization: sub ? Math.round((s.students.length / sub.maxStudents) * 100) : null },
        vehicles: { current: s.vehicles.length, max: sub?.maxVehicles || null, utilization: sub ? Math.round((s.vehicles.length / sub.maxVehicles) * 100) : null },
        subscription: sub ? { plan: sub.plan, status: sub.status, endDate: sub.endDate } : null,
      };
    });

    res.json({ usage });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.createSubscription = async (req, res) => {
  try {
    const { schoolId, plan, maxStudents, maxVehicles, startDate, endDate, amount, currency } = req.body;
    if (!schoolId) return res.status(400).json({ error: 'schoolId is required.' });
    const school = await School.findByPk(schoolId);
    if (!school) return res.status(400).json({ error: 'School not found.' });

    const existing = await Subscription.findOne({ where: { schoolId } });
    if (existing) {
      await existing.update({ plan, maxStudents, maxVehicles, startDate, endDate, amount, currency, status: 'active' });
      return res.json({ message: 'Subscription updated.', subscription: existing });
    }

    const subscription = await Subscription.create({ schoolId, plan, maxStudents, maxVehicles, startDate, endDate, amount, currency, status: 'active' });
    res.status(201).json({ message: 'Subscription created.', subscription });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
