const crypto = require('crypto');
const { User, ParentSchool, Student, School, Trip, Route, Vehicle, TripLog, sequelize } = require('../models');
const { Op } = require('sequelize');
const { normalizePhoneE164 } = require('../utils/phone');

// Random placeholder hash for pending accounts; parents set their own password in the app
const generatePlaceholderPassword = () => crypto.randomBytes(16).toString('hex');

exports.listParents = async (req, res) => {
  try {
    const parents = await User.findAll({
      where: { role: 'parent', isActive: true },
      attributes: { exclude: ['passwordHash'] },
      include: [
        {
          model: ParentSchool,
          as: 'schoolMemberships',
          where: { schoolId: req.user.schoolId },
          attributes: [],
          required: true,
        },
        {
          model: Student,
          as: 'children',
          where: { schoolId: req.user.schoolId, isActive: true },
          required: false,
        },
      ],
      order: [['firstName', 'ASC'], ['lastName', 'ASC']],
    });
    res.json({ parents });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getParent = async (req, res) => {
  try {
    const parent = await User.findOne({
      where: { id: req.params.id, role: 'parent' },
      attributes: { exclude: ['passwordHash'] },
      include: [
        {
          model: ParentSchool,
          as: 'schoolMemberships',
          where: { schoolId: req.user.schoolId },
          attributes: [],
          required: true,
        },
        {
          model: Student,
          as: 'children',
          where: { schoolId: req.user.schoolId },
          required: false,
          include: [{ model: require('../models').Route, as: 'routes', through: { attributes: ['stopOrder'] } }],
        },
      ],
    });
    if (!parent) return res.status(404).json({ error: 'Parent not found' });
    res.json({ parent });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.createParent = async (req, res) => {
  try {
    const { email, firstName, lastName, phone, pickupAddress, pickupLat, pickupLng } = req.body;
    if (!email || !firstName || !lastName || !phone) {
      return res.status(400).json({ error: 'email, firstName, lastName, and phone are required' });
    }

    const normalizedPhone = normalizePhoneE164(phone);
    if (!normalizedPhone) return res.status(400).json({ error: 'A valid phone number is required' });

    const normalizedEmail = email.trim().toLowerCase();
    const matches = await User.findAll({
      where: { role: 'parent', [Op.or]: [{ email: normalizedEmail }, { phone: normalizedPhone }] },
    });
    if (matches.length > 1) {
      return res.status(409).json({ error: 'The email and phone belong to different parent accounts' });
    }
    const existing = matches[0];
    if (existing) {
      const [, created] = await ParentSchool.findOrCreate({
        where: { parentId: existing.id, schoolId: req.user.schoolId },
      });
      if (!created) {
        return res.status(409).json({
          error: 'A user with this email or phone number already belongs to this school',
        });
      }
      return res.status(200).json({
        parent: existing,
        message: 'Existing parent added to this school.',
      });
    }

    // Create the account in a pending state — the parent sets their own password in the app
    const parent = await User.create({
      schoolId: req.user.schoolId,
      email: normalizedEmail,
      passwordHash: generatePlaceholderPassword(),
      firstName,
      lastName,
      role: 'parent',
      phone: normalizedPhone,
      pickupAddress,
      pickupLat,
      pickupLng,
      mustSetPassword: true,
    });
    await ParentSchool.findOrCreate({
      where: { parentId: parent.id, schoolId: req.user.schoolId },
    });

    res.status(201).json({
      parent: { ...parent.toJSON(), passwordHash: undefined },
      message: 'Parent added. They can set their password in the app using their phone number.',
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A user with this email or phone number already exists' });
    res.status(500).json({ error: err.message });
  }
};

exports.updateParent = async (req, res) => {
  try {
    const parent = await User.findOne({
      where: { id: req.params.id, role: 'parent' },
      include: [{
        model: ParentSchool,
        as: 'schoolMemberships',
        where: { schoolId: req.user.schoolId },
        attributes: [],
        required: true,
      }],
    });
    if (!parent) return res.status(404).json({ error: 'Parent not found' });

    const { firstName, lastName, phone, pickupAddress, pickupLat, pickupLng } = req.body;
    const normalizedPhone = normalizePhoneE164(phone);
    if (!normalizedPhone) return res.status(400).json({ error: 'A valid phone number is required' });
    const existing = await User.findOne({
      where: {
        role: 'parent',
        phone: normalizedPhone,
        id: { [Op.ne]: parent.id },
      },
    });
    if (existing) return res.status(409).json({ error: 'A user with this phone number already exists' });
    await parent.update({ firstName, lastName, phone: normalizedPhone, pickupAddress, pickupLat, pickupLng });
    res.json({ parent: { ...parent.toJSON(), passwordHash: undefined } });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A user with this email or phone number already exists' });
    res.status(500).json({ error: err.message });
  }
};

exports.deleteParent = async (req, res) => {
  try {
    const deleted = await sequelize.transaction(async (transaction) => {
      const membership = await ParentSchool.findOne({
        where: { parentId: req.params.id, schoolId: req.user.schoolId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!membership) return false;
      await Student.update(
        { parentId: null },
        {
          where: { parentId: req.params.id, schoolId: req.user.schoolId },
          transaction,
        },
      );
      await membership.destroy({ transaction });
      return true;
    });
    if (!deleted) return res.status(404).json({ error: 'Parent not found' });
    res.json({ message: 'Parent removed from this school' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// Summarize a single student's pickup timeline from a set of trip logs.
// Returns the key event timestamps plus the wait between the bus arriving
// and the student actually being picked up (check_in).
const summarizeStudent = (studentId, logs) => {
  const sl = logs.filter(l => l.studentId === studentId).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const at = act => { const x = sl.find(l => l.action === act); return x ? x.timestamp : null; };
  const arrivedAt = at('arrived'), pickedAt = at('check_in'), droppedAt = at('check_out'), absent = !!at('absent');
  let status = 'pending';
  if (absent) status = 'absent';
  else if (droppedAt) status = 'dropped_off';
  else if (pickedAt) status = 'on_bus';
  else if (arrivedAt) status = 'arrived';
  const waitSeconds = (arrivedAt && pickedAt) ? Math.max(0, Math.round((new Date(pickedAt) - new Date(arrivedAt)) / 1000)) : null;
  return { arrivedAt, pickedAt, droppedAt, absent, status, waitSeconds };
};

// Self-service: completed trips (default last 30 days) that carried the
// authenticated parent's children. Only the parent's own children are
// exposed on each trip for privacy.
exports.getTripHistory = async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const since = new Date(); since.setDate(since.getDate() - days);
    const sinceStr = since.toISOString().split('T')[0];

    const children = await Student.findAll({
      where: { parentId: req.user.id },
      include: [{ model: Route, as: 'routes', attributes: ['id', 'name'], through: { attributes: [] } }],
    });
    if (!children.length) return res.json({ trips: [], total: 0 });

    const routeIds = [...new Set(children.flatMap(c => (c.routes || []).map(r => r.id)))];
    if (!routeIds.length) return res.json({ trips: [], total: 0 });

    const trips = await Trip.findAll({
      where: { routeId: { [Op.in]: routeIds }, status: 'completed', scheduledDate: { [Op.gte]: sinceStr } },
      include: [
        {
          model: Route,
          as: 'route',
          attributes: ['id', 'name', 'schoolId'],
          include: [{ model: School, as: 'school', attributes: ['id', 'name'] }],
        },
        { model: Vehicle, as: 'vehicle', attributes: ['id', 'plateNumber', 'make', 'model'] },
        { model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName', 'phone'] },
        { model: TripLog, as: 'logs' },
      ],
      order: [['scheduled_date', 'DESC'], ['started_at', 'DESC']],
    });

    const result = trips.map(trip => {
      const t = trip.toJSON();
      const logs = t.logs || [];
      const myChildren = children.filter(c => (c.routes || []).some(r => r.id === t.routeId));
      const childRows = myChildren.map(c => {
        const sum = summarizeStudent(c.id, logs);
        return { studentId: c.id, studentName: `${c.firstName} ${c.lastName}`, grade: c.grade, ...sum };
      });
      const durationMinutes = (t.startedAt && t.endedAt) ? Math.round((new Date(t.endedAt) - new Date(t.startedAt)) / 60000) : null;
      return {
        id: t.id, scheduledDate: t.scheduledDate, type: t.type, status: t.status,
        startedAt: t.startedAt, endedAt: t.endedAt, durationMinutes,
        route: { id: t.route?.id, name: t.route?.name },
        school: t.route?.school || null,
        vehicle: t.vehicle,
        driver: t.driver ? { id: t.driver.id, name: `${t.driver.firstName} ${t.driver.lastName}`, phone: t.driver.phone } : null,
        children: childRows,
      };
    });

    res.json({ trips: result, total: result.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
