const jwt = require('jsonwebtoken');
const { User } = require('../models');

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Access denied. No token provided.' });
  try {
    const payload = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'default-secret');
    const user = await User.findByPk(payload.id, { attributes: ['id', 'isActive'] });
    if (!user || !user.isActive) return res.status(401).json({ error: 'Account is inactive or no longer exists.' });
    req.user = payload;
    next();
  }
  catch (err) { return res.status(401).json({ error: 'Invalid or expired token.' }); }
};
const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden.' });
  next();
};
const schoolTenancy = (req, res, next) => {
  if (req.user.role === 'super_admin') return next();
  if (req.params.schoolId && parseInt(req.params.schoolId) !== req.user.schoolId) return res.status(403).json({ error: 'Access denied.' });
  req.schoolId = req.user.schoolId;
  next();
};
module.exports = { authenticate, authorize, schoolTenancy };
