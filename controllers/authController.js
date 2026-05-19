const jwt = require('jsonwebtoken');
const { User, School } = require('../models');
const generateToken = (user) => jwt.sign(
  { id: user.id, email: user.email, role: user.role, schoolId: user.schoolId },
  process.env.JWT_SECRET || 'default-secret', { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);
exports.register = async (req, res) => {
  try {
    const { email, password, firstName, lastName, role, phone, schoolId } = req.body;
    if (await User.findOne({ where: { email } })) return res.status(400).json({ error: 'Email already registered.' });
    const school = await School.findByPk(schoolId);
    if (!school) return res.status(400).json({ error: 'Invalid school ID.' });
    const user = await User.create({ email, passwordHash: password, firstName, lastName, role: role || 'parent', phone, schoolId });
    res.status(201).json({ message: 'User registered.', token: generateToken(user), user });
  } catch (err) { res.status(500).json({ error: 'Registration failed.', details: err.message }); }
};
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ where: { email }, include: [{ model: School, as: 'school', attributes: ['id','name'] }] });
    if (!user || !(await user.validPassword(password))) return res.status(401).json({ error: 'Invalid email or password.' });
    if (!user.isActive) return res.status(403).json({ error: 'Account deactivated.' });
    res.json({ message: 'Login successful.', token: generateToken(user), user });
  } catch (err) { res.status(500).json({ error: 'Login failed.', details: err.message }); }
};
exports.getMe = async (req, res) => {
  try {
    const user = await User.findByPk(req.user.id, { include: [{ model: School, as: 'school', attributes: ['id','name'] }] });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    res.json({ user });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
