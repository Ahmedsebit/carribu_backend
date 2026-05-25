const crypto = require('crypto');
const { User, Vehicle, Route, School } = require('../models');
const { sendWelcomeEmail } = require('../utils/email');

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

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(409).json({ error: 'A user with this email already exists' });

    const tempPassword = generatePassword();
    const driver = await User.create({
      schoolId: req.user.schoolId,
      email,
      passwordHash: tempPassword,
      firstName,
      lastName,
      role: 'driver',
      phone,
    });

    const school = await School.findByPk(req.user.schoolId);
    const emailResult = await sendWelcomeEmail(email, firstName, tempPassword, school?.name || 'Your School');

    res.status(201).json({
      driver: { ...driver.toJSON(), passwordHash: undefined },
      tempPassword,
      emailSent: emailResult.sent || false,
      previewUrl: emailResult.previewUrl || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateDriver = async (req, res) => {
  try {
    const driver = await User.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    const { firstName, lastName, phone } = req.body;
    await driver.update({ firstName, lastName, phone });
    res.json({ driver: { ...driver.toJSON(), passwordHash: undefined }, message: 'Driver updated.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteDriver = async (req, res) => {
  try {
    const driver = await User.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'driver' } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    await driver.update({ isActive: false });
    res.json({ message: 'Driver deactivated.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
