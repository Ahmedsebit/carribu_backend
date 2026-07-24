const { Trip, Route, Vehicle, User, Student, RouteStudent, TripLog } = require('../models');
const { Op } = require('sequelize');

// Summarize a single student's pickup timeline from a set of trip logs.
// Returns the key event timestamps plus the wait between the bus arriving
// and the student actually being picked up (check_in).
const summarizeStudent = (studentId, logs) => {
  const sl = logs.filter(l => l.studentId === studentId).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const at = act => { const x = sl.find(l => l.action === act); return x ? x.timestamp : null; };
  const arrivedAt = at('arrived'), pickedAt = at('check_in'), droppedAt = at('check_out'), absent = !!at('absent');
  let status = 'pending';
  if (absent) status = 'absent';
  else if (droppedAt) status = 'dropped_off';
  else if (pickedAt) status = 'on_bus';
  else if (arrivedAt) status = 'arrived';
  const waitSeconds = (arrivedAt && pickedAt) ? Math.max(0, Math.round((new Date(pickedAt) - new Date(arrivedAt)) / 1000)) : null;
  return { arrivedAt, pickedAt, droppedAt, absent, status, waitSeconds };
};
const historySince = req => {
  const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
  const since = new Date(); since.setDate(since.getDate() - days);
  return since.toISOString().split('T')[0];
};

exports.getMyRoutes = async (req, res) => {
  try {
    const routes = await Route.findAll({ where: { driverId: req.user.id, isActive: true }, include: [
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','capacity','color'] },
      { model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','email','pickupAddress','pickupLat','pickupLng'] }] },
    ], order: [['name','ASC']] });
    const result = routes.map(r => { const j = r.toJSON(); j.students = j.students.sort((a,b) => (a.RouteStudent?.stopOrder||0)-(b.RouteStudent?.stopOrder||0)); return j; });
    res.json({ routes: result, total: result.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getMyTrips = async (req, res) => {
  try {
    // Retire any of this driver's scheduled trips whose start window has
    // lapsed so the list reflects only currently actionable work.
    await checkMissedTrips(Date.now(), { driverId: req.user.id });
    // A trip is "mine" if either its snapshot driverId matches me, or the
    // trip's route is currently assigned to me. The route match keeps trips
    // visible even when the snapshot is stale (e.g. the driver was assigned
    // to the route after the trip was scheduled).
    const mine = { [Op.or]: [{ driverId: req.user.id }, { '$route.driver_id$': req.user.id }] };
    // When a specific date is requested, match it exactly. Otherwise show all
    // current/upcoming work: scheduled trips from today onward plus any active trip,
    // so future-dated scheduled trips don't silently disappear.
    const today = new Date().toISOString().split('T')[0];
    const dateWhere = req.query.date
      ? { scheduledDate: req.query.date }
      : { [Op.or]: [{ scheduledDate: { [Op.gte]: today } }, { status: 'in_progress' }] };
    const where = { [Op.and]: [mine, dateWhere] };
    const trips = await Trip.findAll({ where, subQuery: false, include: [
      { model: Route, as: 'route', attributes: ['id','name'], include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','pickupAddress','pickupLat','pickupLng'] }] }] },
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','capacity'] },
      { model: TripLog, as: 'logs', include: [{ model: Student, as: 'student', attributes: ['id','firstName','lastName'] }] },
    ], order: [['scheduled_date','ASC'],['created_at','ASC']] });
    const result = trips.map(trip => {
      const t = trip.toJSON(); const students = t.route?.students || []; const logs = t.logs || [];
      students.sort((a,b) => (a.RouteStudent?.stopOrder||0)-(b.RouteStudent?.stopOrder||0));
      t.pickupList = students.map((s,idx) => {
        const sl = logs.filter(l => l.studentId === s.id);
        let status = 'pending';
        if (sl.find(l => l.action === 'absent')) status = 'absent';
        else if (sl.find(l => l.action === 'check_out')) status = 'dropped_off';
        else if (sl.find(l => l.action === 'check_in')) status = 'on_bus';
        else if (sl.find(l => l.action === 'arrived')) status = 'arrived';
        return { stopNumber: idx+1, studentId: s.id, studentName: `${s.firstName} ${s.lastName}`, grade: s.grade, pickupAddress: s.parent?.pickupAddress, pickupLat: s.parent?.pickupLat, pickupLng: s.parent?.pickupLng, dropoffAddress: s.parent?.pickupAddress, dropoffLat: s.parent?.pickupLat, dropoffLng: s.parent?.pickupLng, parentName: s.parent ? `${s.parent.firstName} ${s.parent.lastName}` : null, parentPhone: s.parent?.phone, parentId: s.parent?.id, status };
      });
      t.nextPickup = t.pickupList.find(s => s.status === 'pending') || null;
      return t;
    });
    res.json({ trips: result, total: result.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getTripHistory = async (req, res) => {
  try {
    const sinceStr = historySince(req);
    const trips = await Trip.findAll({ where: { driverId: req.user.id, status: 'completed', scheduledDate: { [Op.gte]: sinceStr } }, include: [
      { model: Route, as: 'route', attributes: ['id','name'], include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] } }] },
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model'] },
      { model: TripLog, as: 'logs' },
    ], order: [['scheduled_date','DESC'],['started_at','DESC']] });
    const result = trips.map(trip => {
      const t = trip.toJSON();
      const students = (t.route?.students || []).sort((a,b) => (a.RouteStudent?.stopOrder||0)-(b.RouteStudent?.stopOrder||0));
      const logs = t.logs || [];
      const pickupList = students.map((s,idx) => { const sum = summarizeStudent(s.id, logs); return { stopNumber: idx+1, studentId: s.id, studentName: `${s.firstName} ${s.lastName}`, grade: s.grade, ...sum }; });
      const stats = { total: pickupList.length, pickedUp: pickupList.filter(p => p.status==='on_bus'||p.status==='dropped_off').length, absent: pickupList.filter(p => p.status==='absent').length };
      const durationMinutes = (t.startedAt && t.endedAt) ? Math.round((new Date(t.endedAt)-new Date(t.startedAt))/60000) : null;
      return { id: t.id, scheduledDate: t.scheduledDate, type: t.type, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, durationMinutes, route: { id: t.route?.id, name: t.route?.name }, vehicle: t.vehicle, pickupList, stats };
    });
    res.json({ trips: result, total: result.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getActiveTrip = async (req, res) => {
  try {
    const trip = await Trip.findOne({ where: { [Op.or]: [{ driverId: req.user.id }, { '$route.driver_id$': req.user.id }], status: 'in_progress' }, subQuery: false, include: [
      { model: Route, as: 'route', include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','pickupAddress','pickupLat','pickupLng'] }] }] },
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','capacity'] },
      { model: TripLog, as: 'logs', include: [{ model: Student, as: 'student', attributes: ['id','firstName','lastName'] }] },
    ]});
    if (!trip) return res.json({ activeTrip: null, message: 'No active trip.' });
    const t = trip.toJSON(); const students = t.route?.students || []; const logs = t.logs || [];
    students.sort((a,b) => (a.RouteStudent?.stopOrder||0)-(b.RouteStudent?.stopOrder||0));
    t.pickupList = students.map((s,idx) => {
      const sl = logs.filter(l => l.studentId === s.id);
      let status = 'pending';
      if (sl.find(l => l.action === 'absent')) status = 'absent';
      else if (sl.find(l => l.action === 'check_out')) status = 'dropped_off';
      else if (sl.find(l => l.action === 'check_in')) status = 'on_bus';
      else if (sl.find(l => l.action === 'arrived')) status = 'arrived';
      return { stopNumber: idx+1, studentId: s.id, studentName: `${s.firstName} ${s.lastName}`, grade: s.grade, pickupAddress: s.parent?.pickupAddress, pickupLat: s.parent?.pickupLat, pickupLng: s.parent?.pickupLng, dropoffAddress: s.parent?.pickupAddress, dropoffLat: s.parent?.pickupLat, dropoffLng: s.parent?.pickupLng, parentName: s.parent ? `${s.parent.firstName} ${s.parent.lastName}` : null, parentPhone: s.parent?.phone, parentId: s.parent?.id, status };
    });
    t.nextPickup = t.pickupList.find(s => s.status === 'pending') || null;
    t.stats = { total: t.pickupList.length, onBus: t.pickupList.filter(s => s.status==='on_bus').length, droppedOff: t.pickupList.filter(s => s.status==='dropped_off').length, absent: t.pickupList.filter(s => s.status==='absent').length, pending: t.pickupList.filter(s => s.status==='pending').length, arrived: t.pickupList.filter(s => s.status==='arrived').length };
    res.json({ activeTrip: t });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
