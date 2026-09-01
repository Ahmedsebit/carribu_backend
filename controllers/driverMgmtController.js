const crypto = require('crypto');
const { User, Vehicle, Route, School, Trip, sequelize } = require('../models');
const { Op } = require('sequelize');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('../utils/email');
const { normalizePhoneE164 } = require('../utils/phone');

const generatePassword = () => crypto.randomBytes(4).toString('hex');

exports.listDrivers = async (req, res) => {
  try {
    const drivers = await User.findAll({
      where: { schoolId: req.user.schoolId, role: 'driver', isActive: true },
      attributes: { exclude: ['passwordHash'] },
      include: [{ model: Route, as: 'assignedRoutes', attributes: ['id','name','type'], where: { isActive: true }, required: false, include: [{ model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model'] }] }],
      order: [['firstName', 'ASC']],
    });
    res.json({ drivers });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getDriver = async (req, res) => {
  try {
    const driver = await User.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' },
      attributes: { exclude: ['passwordHash'] },
      include: [{ model: Route, as: 'assignedRoutes', where: { isActive: true }, required: false, include: [{ model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model'] }] }],
    });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    res.json({ driver });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.createDriver = async (req, res) => {
  try {
    const { email, firstName, lastName, phone } = req.body;
    if (!email || !firstName || !lastName) {
      return res.status(400).json({ error: 'email, firstName, and lastName are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone ? normalizePhoneE164(phone) : null;
    if (phone && !normalizedPhone) return res.status(400).json({ error: 'A valid phone number is required' });
    const identities = [{ email: normalizedEmail }];
    if (normalizedPhone) identities.push({ phone: normalizedPhone });
    const existing = await User.findOne({
      where: { schoolId: req.user.schoolId, [Op.or]: identities },
    });
    if (existing) return res.status(409).json({ error: 'A user with this email or phone number already exists' });

    const tempPassword = generatePassword();
    const driver = await User.create({
      schoolId: req.user.schoolId,
      email: normalizedEmail,
      passwordHash: tempPassword,
      firstName,
      lastName,
      role: 'driver',
      phone: normalizedPhone,
    });

    const school = await School.findByPk(req.user.schoolId);
    const emailResult = await sendWelcomeEmail(email, firstName, tempPassword, school?.name || 'Your School');

    res.status(201).json({
      driver: { ...driver.toJSON(), passwordHash: undefined },
      tempPassword,
      emailSent: emailResult.sent || false,
      previewUrl: emailResult.previewUrl || null,
    });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A user with this email or phone number already exists' });
    res.status(500).json({ error: err.message });
  }
};

exports.updateDriver = async (req, res) => {
  try {
    const driver = await User.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    const { firstName, lastName, phone } = req.body;
    const normalizedPhone = phone ? normalizePhoneE164(phone) : null;
    if (phone && !normalizedPhone) return res.status(400).json({ error: 'A valid phone number is required' });
    if (normalizedPhone) {
      const existing = await User.findOne({
        where: {
          schoolId: req.user.schoolId,
          phone: normalizedPhone,
          id: { [Op.ne]: driver.id },
        },
      });
      if (existing) return res.status(409).json({ error: 'A user with this phone number already exists' });
    }
    await driver.update({ firstName, lastName, phone: normalizedPhone });
    res.json({ driver: { ...driver.toJSON(), passwordHash: undefined }, message: 'Driver updated.' });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ error: 'A user with this email or phone number already exists' });
    res.status(500).json({ error: err.message });
  }
};

exports.resetPassword = async (req, res) => {
  try {
    const driver = await User.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const newPassword = generatePassword();
    await driver.update({ passwordHash: newPassword });

    const school = await School.findByPk(req.user.schoolId);
    const emailResult = await sendPasswordResetEmail(driver.email, driver.firstName, newPassword, school?.name || 'Your School');

    res.json({
      message: 'Password reset successfully.',
      tempPassword: newPassword,
      emailSent: emailResult.sent || false,
      previewUrl: emailResult.previewUrl || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteDriver = async (req, res) => {
  try {
    const result = await sequelize.transaction(async (transaction) => {
      const driver = await User.findOne({
        where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!driver) return { status: 404, error: 'Driver not found' };

      const activeTrip = await Trip.findOne({
        where: { driverId: driver.id, status: 'in_progress' },
        transaction,
      });
      if (activeTrip) {
        return {
          status: 409,
          error: 'This driver has a trip in progress. End the trip before deleting the driver.',
        };
      }

      await driver.destroy({ transaction });
      return { status: 200 };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ message: 'Driver deleted.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
