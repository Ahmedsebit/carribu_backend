const { Trip, Route, Vehicle, User, Student, RouteStudent, TripLog } = require('../models');
const { Op } = require('sequelize');
const { checkMissedTrips } = require('../services/tripReminders');
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
    // When a specific date is requested, match it exactly. Otherwise show all
    // current/upcoming work: scheduled trips from today onward plus any active trip,
    // so future-dated scheduled trips don't silently disappear.
    const today = new Date().toISOString().split('T')[0];
    const where = req.query.date
      ? { driverId: req.user.id, scheduledDate: req.query.date }
      : { driverId: req.user.id, [Op.or]: [{ scheduledDate: { [Op.gte]: today } }, { status: 'in_progress' }] };
    const trips = await Trip.findAll({ where, include: [
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
exports.getActiveTrip = async (req, res) => {
  try {
    const trip = await Trip.findOne({ where: { driverId: req.user.id, status: 'in_progress' }, include: [
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
