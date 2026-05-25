const crypto = require('crypto');
const { User, Student, School } = require('../models');
const { sendWelcomeEmail } = require('../utils/email');

const generatePassword = () => crypto.randomBytes(4).toString('hex'); // 8-char random password

exports.listParents = async (req, res) => {
  try {
    const parents = await User.findAll({
      where: { schoolId: req.user.schoolId, role: 'parent', isActive: true },
      attributes: { exclude: ['passwordHash'] },
      include: [{ model: Student, as: 'children', where: { isActive: true }, required: false }],
      order: [['firstName', 'ASC']],
    });
    res.json({ parents });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.getParent = async (req, res) => {
  try {
    const parent = await User.findOne({
      where: { id: req.params.id, schoolId: req.user.schoolId, role: 'parent' },
      attributes: { exclude: ['passwordHash'] },
      include: [{ model: Student, as: 'children', include: [{ model: require('../models').Route, as: 'routes', through: { attributes: ['stopOrder'] } }] }],
    });
    if (!parent) return res.status(404).json({ error: 'Parent not found' });
    res.json({ parent });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.createParent = async (req, res) => {
  try {
    const { email, firstName, lastName, phone, pickupAddress, pickupLat, pickupLng } = req.body;
    if (!email || !firstName || !lastName) {
      return res.status(400).json({ error: 'email, firstName, and lastName are required' });
    }

    const existing = await User.findOne({ where: { email } });
    if (existing) return res.status(409).json({ error: 'A user with this email already exists' });

    const tempPassword = generatePassword();
    const parent = await User.create({
      schoolId: req.user.schoolId,
      email,
      passwordHash: tempPassword, // Will be hashed by beforeCreate hook
      firstName,
      lastName,
      role: 'parent',
      phone,
      pickupAddress,
      pickupLat,
      pickupLng,
    });

    // Send welcome email
    const school = await School.findByPk(req.user.schoolId);
    const emailResult = await sendWelcomeEmail(email, firstName, tempPassword, school?.name || 'Your School');

    res.status(201).json({
      parent: { ...parent.toJSON(), passwordHash: undefined },
      tempPassword,
      emailSent: emailResult.sent || false,
      previewUrl: emailResult.previewUrl || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.updateParent = async (req, res) => {
  try {
    const parent = await User.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'parent' } });
    if (!parent) return res.status(404).json({ error: 'Parent not found' });

    const { firstName, lastName, phone, pickupAddress, pickupLat, pickupLng } = req.body;
    await parent.update({ firstName, lastName, phone, pickupAddress, pickupLat, pickupLng });
    res.json({ parent: { ...parent.toJSON(), passwordHash: undefined } });
  } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.deleteParent = async (req, res) => {
  try {
    const parent = await User.findOne({ where: { id: req.params.id, schoolId: req.user.schoolId, role: 'parent' } });
    if (!parent) return res.status(404).json({ error: 'Parent not found' });
    await parent.update({ isActive: false });
    res.json({ message: 'Parent deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
