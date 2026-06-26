const crypto = require('crypto');
const { User, Student, School } = require('../models');
const { normalizePhoneE164 } = require('../utils/phone');

// Random placeholder hash for pending accounts; parents set their own password in the app
const generatePlaceholderPassword = () => crypto.randomBytes(16).toString('hex');

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
    if (!email || !firstName || !lastName || !phone) {
      return res.status(400).json({ error: 'email, firstName, lastName, and phone are required' });
    }

    const normalizedPhone = normalizePhoneE164(phone);
    if (!normalizedPhone) return res.status(400).json({ error: 'A valid phone number is required' });

    const existingEmail = await User.findOne({ where: { email } });
    if (existingEmail) return res.status(409).json({ error: 'A user with this email already exists' });

    const existingPhone = await User.findOne({ where: { phone: normalizedPhone, role: 'parent', isActive: true } });
    if (existingPhone) return res.status(409).json({ error: 'A parent with this phone number already exists' });

    // Create the account in a pending state — the parent sets their own password in the app
    const parent = await User.create({
      schoolId: req.user.schoolId,
      email,
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

    res.status(201).json({
      parent: { ...parent.toJSON(), passwordHash: undefined },
      message: 'Parent added. They can set their password in the app using their phone number.',
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
