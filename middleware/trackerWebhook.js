const crypto = require('crypto');

function secureEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authenticateTracker(req, res, next) {
  const configured = process.env.TRACKER_WEBHOOK_TOKEN;
  if (!configured) {
    console.error('TRACKER_WEBHOOK_TOKEN is not configured.');
    return res.status(503).json({ error: 'Tracker webhook is not configured.' });
  }
  const authorization = req.get('authorization') || '';
  const supplied = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length).trim()
    : req.get('x-tracker-token');
  if (!secureEqual(supplied, configured)) {
    return res.status(401).json({ error: 'Invalid tracker webhook token.' });
  }
  next();
}

module.exports = { authenticateTracker };
