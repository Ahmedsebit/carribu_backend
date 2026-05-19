const jwt = require('jsonwebtoken');
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Access denied. No token provided.' });
  try { req.user = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'default-secret'); next(); }
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
