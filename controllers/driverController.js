const { Trip, Route, Vehicle, User, Student, RouteStudent, TripLog } = require('../models');
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
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const trips = await Trip.findAll({ where: { driverId: req.user.id, scheduledDate: date }, include: [
      { model: Route, as: 'route', attributes: ['id','name'], include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','pickupAddress','pickupLat','pickupLng','dropoffAddress','dropoffLat','dropoffLng'] }] }] },
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','capacity'] },
      { model: TripLog, as: 'logs', include: [{ model: Student, as: 'student', attributes: ['id','firstName','lastName'] }] },
    ], order: [['created_at','ASC']] });
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
        return { stopNumber: idx+1, studentId: s.id, studentName: `${s.firstName} ${s.lastName}`, grade: s.grade, pickupAddress: s.parent?.pickupAddress, pickupLat: s.parent?.pickupLat, pickupLng: s.parent?.pickupLng, dropoffAddress: s.parent?.dropoffAddress, dropoffLat: s.parent?.dropoffLat, dropoffLng: s.parent?.dropoffLng, parentName: s.parent ? `${s.parent.firstName} ${s.parent.lastName}` : null, parentPhone: s.parent?.phone, parentId: s.parent?.id, status };
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
      { model: Route, as: 'route', include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','pickupAddress','pickupLat','pickupLng','dropoffAddress','dropoffLat','dropoffLng'] }] }] },
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
      return { stopNumber: idx+1, studentId: s.id, studentName: `${s.firstName} ${s.lastName}`, grade: s.grade, pickupAddress: s.parent?.pickupAddress, pickupLat: s.parent?.pickupLat, pickupLng: s.parent?.pickupLng, dropoffAddress: s.parent?.dropoffAddress, dropoffLat: s.parent?.dropoffLat, dropoffLng: s.parent?.dropoffLng, parentName: s.parent ? `${s.parent.firstName} ${s.parent.lastName}` : null, parentPhone: s.parent?.phone, parentId: s.parent?.id, status };
    });
    t.nextPickup = t.pickupList.find(s => s.status === 'pending') || null;
    t.stats = { total: t.pickupList.length, onBus: t.pickupList.filter(s => s.status==='on_bus').length, droppedOff: t.pickupList.filter(s => s.status==='dropped_off').length, absent: t.pickupList.filter(s => s.status==='absent').length, pending: t.pickupList.filter(s => s.status==='pending').length, arrived: t.pickupList.filter(s => s.status==='arrived').length };
    res.json({ activeTrip: t });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
