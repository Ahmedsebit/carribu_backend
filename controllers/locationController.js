const { BusLocation, Trip, Route, Vehicle, User, Student, TripLog, School } = require('../models');
const { Op } = require('sequelize');
const { distanceInMeters, recordDriverLocation, getTripLocationWhere } = require('../services/locationTracking');
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
      where: { parentId: req.user.id, schoolId: trip.route.schoolId, isActive: true },
      include: [{
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
    res.json({ location: { lat: parseFloat(loc.lat), lng: parseFloat(loc.lng), speed: loc.speed == null ? null : parseFloat(loc.speed), heading: loc.heading == null ? null : parseFloat(loc.heading), recordedAt: loc.recordedAt, source: loc.source, vehicle: loc.vehicle, driver: loc.driver, trip: { id: trip.id, status: trip.status, type: trip.type, route: trip.route } } });
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
    const parentUser = await User.findByPk(req.user.id, { attributes: ['id','pickupLat','pickupLng','dropoffLat','dropoffLng'] });
    const activeSchoolIds = await getActiveParentSchoolIds(req.user.id);
    const children = await Student.findAll({ where: { parentId: req.user.id, schoolId: { [Op.in]: activeSchoolIds }, isActive: true }, include: [{ model: Route, as: 'routes', through: { attributes: ['stopOrder'] }, include: [
      { model: Trip, as: 'trips', where: { status: 'in_progress' }, required: false, include: [
        { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','color','trackerUniqueId'] },
        { model: User, as: 'driver', attributes: ['id','firstName','lastName','phone'] },
      ] },
      { model: School, as: 'school', attributes: ['id','name'] },
      { model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','pickupLat','pickupLng','dropoffLat','dropoffLng'] }] },
    ] }] });
    const activeBuses = []; const seen = new Set();
    const STOP_BUFFER_MINUTES = 3; // extra minutes per stop before the child's pickup
    const DEFAULT_SPEED_KMH = 30; // fallback speed when GPS speed unavailable

    for (const child of children) {
      for (const route of (child.routes || [])) {
        for (const trip of (route.trips || [])) {
          if (!seen.has(trip.id)) { seen.add(trip.id);
            const latest = await BusLocation.findOne({ where: await getTripLocationWhere(trip), order: [['recorded_at','DESC']] });

            // Calculate ETA for each of this parent's children on the route
            const tripLogs = await TripLog.findAll({ where: { tripId: trip.id } });
            const pickedUp = new Set(tripLogs.filter(l => l.action === 'check_in' || l.action === 'check_out' || l.action === 'absent').map(l => l.studentId));

            const childrenOnRoute = children.filter(c => c.routes.some(r => r.id === route.id));
            const childrenEta = childrenOnRoute.map(c => {
              const childStopOrder = c.routes.find(r => r.id === route.id)?.RouteStudent?.stopOrder || 0;
              let eta = null;

              if (latest && parentUser.pickupLat && parentUser.pickupLng) {
                const busLat = parseFloat(latest.lat);
                const busLng = parseFloat(latest.lng);
                const childLat = parseFloat(parentUser.pickupLat);
                const childLng = parseFloat(parentUser.pickupLng);
                const distance = distanceInMeters(busLat, busLng, childLat, childLng);
                const distanceKm = distance / 1000;

                // Count stops before this child that haven't been visited yet
                const stopsBefore = (route.students || []).filter(s =>
                  s.RouteStudent.stopOrder < childStopOrder && !pickedUp.has(s.id)
                ).length;

                const speedKmh = (latest.speed && parseFloat(latest.speed) > 0) ? parseFloat(latest.speed) : DEFAULT_SPEED_KMH;
                const travelMinutes = (distanceKm / speedKmh) * 60;
                const bufferMinutes = stopsBefore * STOP_BUFFER_MINUTES;
                const totalMinutes = Math.round(travelMinutes + bufferMinutes);

                eta = {
                  distanceKm: Math.round(distanceKm * 10) / 10,
                  distanceMeters: Math.round(distance),
                  travelMinutes: Math.round(travelMinutes),
                  stopsBefore,
                  bufferMinutes,
                  totalMinutes,
                  alreadyPickedUp: pickedUp.has(c.id),
                };
              }

              return { id: c.id, firstName: c.firstName, lastName: c.lastName, grade: c.grade, eta };
            });

            // Build pending stops list for map display (privacy-aware)
            const isMorning = trip.type === 'morning_pickup';
            const myChildIds = new Set(children.map(c => c.id));
            const pendingStops = (route.students || [])
              .filter(s => !pickedUp.has(s.id))
              .filter(s => {
                if (!s.parent) return false;
                const lat = isMorning ? s.parent.pickupLat : s.parent.dropoffLat;
                const lng = isMorning ? s.parent.pickupLng : s.parent.dropoffLng;
                return lat && lng;
              })
              .sort((a, b) => {
                const direction = isMorning ? 1 : -1;
                return direction * ((a.RouteStudent.stopOrder || 0) - (b.RouteStudent.stopOrder || 0));
              })
              .map((s, index) => {
                const lat = parseFloat(isMorning ? s.parent.pickupLat : s.parent.dropoffLat);
                const lng = parseFloat(isMorning ? s.parent.pickupLng : s.parent.dropoffLng);
                const isMyChild = myChildIds.has(s.id);
                const stop = { stopOrder: index + 1, lat, lng, isMyChild };
                if (isMyChild) { stop.studentId = s.id; stop.firstName = s.firstName; }
                return stop;
              });

            activeBuses.push({ tripId: trip.id, tripType: trip.type, routeName: route.name, routeSchool: route.school ? route.school.name : null, vehicle: trip.vehicle, driver: trip.driver, location: latest ? { lat: parseFloat(latest.lat), lng: parseFloat(latest.lng), speed: latest.speed == null ? null : parseFloat(latest.speed), recordedAt: latest.recordedAt, source: latest.source } : null, children: childrenEta, pendingStops });
          }
        }
      }
    }
    res.json({ activeBuses, total: activeBuses.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
