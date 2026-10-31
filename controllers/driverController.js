const { Trip, Route, Vehicle, User, Student, RouteStudent, RouteWaypoint, TripLog } = require('../models');
const { Op } = require('sequelize');
const { checkDelayedTrips, checkMissedTrips } = require('../services/tripReminders');
const { getLocationSource } = require('../services/locationTracking');
const { getTripState } = require('../services/tripPlan');

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
    // Refresh this driver's trip state: flag trips past their start time as
    // 'delayed', then retire any whose start window has fully lapsed as
    // 'missed', so the list reflects only currently actionable work.
    await checkDelayedTrips(Date.now(), { driverId: req.user.id });
    await checkMissedTrips(Date.now(), { driverId: req.user.id });
    const mine = { driverId: req.user.id };
    // When a specific date is requested, match it exactly. Otherwise show all
    // current/upcoming work: scheduled trips from today onward plus any active trip,
    // so future-dated scheduled trips don't silently disappear.
    const today = new Date().toISOString().split('T')[0];
    const dateWhere = req.query.date
      ? { scheduledDate: req.query.date }
      : { [Op.or]: [{ scheduledDate: { [Op.gte]: today } }, { status: 'in_progress' }] };
    const where = { [Op.and]: [mine, dateWhere] };
    const trips = await Trip.findAll({ where, subQuery: false, include: [
      { model: Route, as: 'route', attributes: ['id','name'], include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','pickupAddress','pickupLat','pickupLng','dropoffAddress','dropoffLat','dropoffLng'] }] }] },
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','capacity','trackerUniqueId'] },
      { model: TripLog, as: 'logs', include: [{ model: Student, as: 'student', attributes: ['id','firstName','lastName'] }] },
    ], order: [['scheduled_date','ASC'],['created_at','ASC']] });
    const result = trips.map(trip => {
      const t = trip.toJSON();
      t.locationSource = t.vehicle ? getLocationSource(t.vehicle) : null;
      Object.assign(t, getTripState(t));
      t.nextPickup = t.currentStop;
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
      const { pickupList } = getTripState(t);
      const stats = { total: pickupList.length, pickedUp: pickupList.filter(p => p.status==='on_bus'||p.status==='dropped_off').length, absent: pickupList.filter(p => p.status==='absent').length };
      const durationMinutes = (t.startedAt && t.endedAt) ? Math.round((new Date(t.endedAt)-new Date(t.startedAt))/60000) : null;
      return { id: t.id, scheduledDate: t.scheduledDate, type: t.type, status: t.status, startedAt: t.startedAt, endedAt: t.endedAt, durationMinutes, route: { id: t.route?.id, name: t.route?.name }, vehicle: t.vehicle, pickupList, stats };
    });
    res.json({ trips: result, total: result.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getActiveTrip = async (req, res) => {
  try {
    const trip = await Trip.findOne({ where: {
      driverId: req.user.id,
      status: 'in_progress',
    }, include: [
      { model: Route, as: 'route', include: [{ model: RouteWaypoint, as: 'routeWaypoints' }, { model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','pickupAddress','pickupLat','pickupLng','dropoffAddress','dropoffLat','dropoffLng'] }] }] },
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','capacity','trackerUniqueId'] },
      { model: TripLog, as: 'logs', include: [{ model: Student, as: 'student', attributes: ['id','firstName','lastName'] }] },
    ]});
    if (!trip) return res.json({ activeTrip: null, message: 'No active trip.' });
    const t = trip.toJSON();
    t.locationSource = t.vehicle ? getLocationSource(t.vehicle) : null;
    Object.assign(t, getTripState(t));
    t.nextPickup = t.currentStop;
    res.json({ activeTrip: t });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
