const { AuditLog } = require('../models');

const auditLog = (action, resource) => async (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    // Log after successful response
    if (res.statusCode < 400 && req.user) {
      AuditLog.create({
        userId: req.user.id,
        schoolId: req.user.schoolId || null,
        action,
        resource,
        resourceId: req.params.id || body?.school?.id || body?.user?.id || null,
        details: JSON.stringify({ method: req.method, path: req.originalUrl }),
        ipAddress: req.ip || req.connection?.remoteAddress,
      }).catch(() => {}); // Non-blocking
    }
    return originalJson(body);
  };
  next();
};

const logLogin = async (userId, email, ipAddress, success) => {
  await AuditLog.create({
    userId: success ? userId : null,
    action: success ? 'login_success' : 'login_failed',
    resource: 'auth',
    details: JSON.stringify({ email }),
    ipAddress,
  }).catch(() => {});
};

module.exports = { auditLog, logLogin };
