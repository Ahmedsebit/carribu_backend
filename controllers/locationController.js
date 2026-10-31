const { BusLocation, Trip, Route, Vehicle, User, Student, TripLog, School } = require('../models');
const { Op } = require('sequelize');
const { recordDriverLocation, getTripLocationWhere } = require('../services/locationTracking');
const { getTripState, estimateStopETA, locationFreshness } = require('../services/tripPlan');
const {
  getActiveParentSchoolIds,
  hasActiveParentSchool,
} = require('../utils/parentSchoolAccess');

async function getLocationTrip(req) {
  const trip = await Trip.findByPk(req.params.tripId, {
    include: [
      { model: Route, as: 'route', attributes: ['id', 'name', 'schoolId'] },
      { model: Vehicle, as: 'vehicle', attributes: ['id', 'trackerUniqueId'] },
    ],
  });
  if (!trip) return null;
  if (req.user.role === 'parent') {
    if (!await hasActiveParentSchool(req.user.id, trip.route?.schoolId)) return null;
    const childOnRoute = await Student.findOne({
      where: {
        parentId: req.user.id, schoolId: trip.route.schoolId, isActive: true,
        ...(trip.plan && { id: { [Op.in]: trip.plan.stops.filter(s => s.parentId === req.user.id).map(s => s.studentId) } }),
      },
      include: trip.plan ? [] : [{
        model: Route, as: 'routes', where: { id: trip.routeId },
        attributes: [], through: { attributes: [] }, required: true,
      }],
    });
    if (!childOnRoute) return null;
  } else if (req.user.role !== 'super_admin' && trip.route?.schoolId !== req.user.schoolId) {
    return null;
  }
  return trip;
}

exports.updateLocation = async (req, res) => {
  try {
    const { location } = await recordDriverLocation(req.body, req.user);
    res.status(201).json({ message: 'Location updated.', location });
  } catch (err) { res.status(err.status || 500).json({ error: err.message, ...(err.code && { code: err.code }) }); }
};
exports.getBusLocation = async (req, res) => {
  try {
    const trip = await getLocationTrip(req);
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    const loc = await BusLocation.findOne({ where: await getTripLocationWhere(trip), include: [
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','color'] },
      { model: User, as: 'driver', attributes: ['id','firstName','lastName','phone'] },
    ], order: [['recorded_at','DESC']] });
    if (!loc) return res.status(404).json({ error: 'No location data.' });
    res.json({ location: { lat: parseFloat(loc.lat), lng: parseFloat(loc.lng), speed: loc.speed == null ? null : parseFloat(loc.speed), heading: loc.heading == null ? null : parseFloat(loc.heading), recordedAt: loc.recordedAt, source: loc.source, ...locationFreshness(loc.recordedAt), vehicle: loc.vehicle, driver: loc.driver, trip: { id: trip.id, status: trip.status, type: trip.type, route: trip.route } } });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.getLocationHistory = async (req, res) => {
  try {
    const trip = await getLocationTrip(req);
    if (!trip) return res.status(404).json({ error: 'Trip not found.' });
    const locs = await BusLocation.findAll({ where: await getTripLocationWhere(trip), attributes: ['lat','lng','speed','heading','recordedAt','source'], order: [['recorded_at','ASC']] });
    res.json({ locations: locs.map(l => ({ lat: parseFloat(l.lat), lng: parseFloat(l.lng), speed: l.speed == null ? null : parseFloat(l.speed), recordedAt: l.recordedAt, source: l.source })), total: locs.length });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
};
exports.getMyChildBus = async (req, res) => {
  try {
    const activeSchoolIds = await getActiveParentSchoolIds(req.user.id);
    const children = await Student.findAll({
      where: { parentId: req.user.id, schoolId: { [Op.in]: activeSchoolIds }, isActive: true },
      attributes: ['id'],
    });
    const ownIds = new Set(children.map(c => c.id));
    const trips = await Trip.findAll({
      where: {
        status: 'in_progress',
        [Op.or]: [{ plan: { [Op.contains]: { stops: [{ parentId: req.user.id }] } } }, { plan: null }],
      },
      include: [
        {
          model: Route, as: 'route', where: { schoolId: { [Op.in]: activeSchoolIds } },
          include: [
            { model: School, as: 'school', attributes: ['id', 'name'] },
            { model: Student, as: 'students', through: { attributes: ['stopOrder'] },
              include: [{ model: User, as: 'parent', attributes: ['id', 'firstName', 'lastName', 'phone', 'pickupLat', 'pickupLng', 'pickupAddress', 'dropoffLat', 'dropoffLng', 'dropoffAddress'] }] },
          ],
        },
        { model: Vehicle, as: 'vehicle', attributes: ['id', 'plateNumber', 'make', 'model', 'color', 'trackerUniqueId'] },
        { model: User, as: 'driver', attributes: ['id', 'firstName', 'lastName', 'phone'] },
        { model: TripLog, as: 'logs' },
      ],
    });
    const activeBuses = [];
    for (const trip of trips) {
      const state = getTripState(trip);
      const own = state.pickupList.filter(s => s.parentId === req.user.id && ownIds.has(s.studentId));
      if (!own.length) continue;
      const latest = await BusLocation.findOne({ where: await getTripLocationWhere(trip), order: [['recorded_at', 'DESC']] });
      const pickupPhase = ['pickup', 'boarding'].includes(state.phase);
      const queue = state.pickupList.filter(s => pickupPhase
        ? ['pending', 'arrived_pickup'].includes(s.status) : ['on_bus', 'arrived_dropoff'].includes(s.status));
      const pendingStops = queue.flatMap((s, index) => {
        const destination = pickupPhase ? s.pickup : s.dropoff;
        if (destination.lat == null || destination.lng == null) return [];
        const isMyChild = ownIds.has(s.studentId);
        return [{
          stopOrder: index + 1, ...destination, isMyChild,
          ...(isMyChild && { studentId: s.studentId, firstName: s.firstName }),
        }];
      });
      activeBuses.push({
        tripId: trip.id, tripType: trip.type, phase: state.phase,
        routeName: trip.plan?.routeName || trip.route.name, routeSchool: trip.route.school?.name,
        vehicle: trip.vehicle, driver: trip.driver,
        location: latest ? {
          lat: Number(latest.lat), lng: Number(latest.lng), speed: latest.speed == null ? null : Number(latest.speed),
          recordedAt: latest.recordedAt, source: latest.source, ...locationFreshness(latest.recordedAt),
        } : null,
        children: own.map(s => ({
          id: s.studentId, firstName: s.firstName, lastName: s.lastName, grade: s.grade, status: s.status,
          eta: state.phase === 'boarding' ? null : estimateStopETA(state, s.studentId, latest),
        })),
        pendingStops,
      });
    }
    res.json({ activeBuses, total: activeBuses.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
