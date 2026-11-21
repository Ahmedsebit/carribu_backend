const jwt = require('jsonwebtoken');
const { User } = require('../models');

const getAuthenticatedUser = async token => {
  let payload;
  try { payload = jwt.verify(token, process.env.JWT_SECRET || 'default-secret'); }
  catch (err) { throw Object.assign(new Error('Invalid or expired token.'), { status: 401 }); }
  const user = await User.findByPk(payload.id, { attributes: ['id', 'email', 'role', 'schoolId', 'isActive', 'mustSetPassword', 'authVersion'] });
  if (!user || !user.isActive || user.role === 'parent' && user.mustSetPassword) {
    throw Object.assign(new Error('Account is inactive or no longer exists.'), { status: 401 });
  }
  if ((payload.authVersion ?? 0) !== (user.authVersion || 0)) {
    throw Object.assign(new Error('This session is no longer valid. Sign in again.'), { status: 401 });
  }
  return { ...payload, id: user.id, email: user.email, role: user.role, schoolId: user.schoolId, authVersion: user.authVersion || 0 };
};

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Access denied. No token provided.' });
  try {
    req.user = await getAuthenticatedUser(authHeader.split(' ')[1]);
    next();
  }
  catch (err) { return res.status(401).json({ error: err.status === 401 ? err.message : 'Invalid or expired token.' }); }
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
module.exports = { authenticate, authorize, schoolTenancy, getAuthenticatedUser };
