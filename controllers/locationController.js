const { BusLocation, Trip, Route, Vehicle, User, Student, TripLog, School } = require('../models');
const { Op } = require('sequelize');
const { distanceInMeters, recordLocation } = require('../services/locationTracking');
const {
  getActiveParentSchoolIds,
  hasActiveParentSchool,
} = require('../utils/parentSchoolAccess');
exports.updateLocation = async (req, res) => {
  try {
    const { tripId, lat, lng, speed, heading } = req.body;
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!tripId || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: 'tripId, lat, lng required.' });
    }
    const trip = await Trip.findOne({ where: { id: tripId, driverId: req.user.id, status: 'in_progress' } });
    if (!trip) return res.status(404).json({ error: 'Active trip not found.' });
    const { location } = await recordLocation({
      trip,
      schoolId: req.user.schoolId,
      driverId: req.user.id,
      lat: latitude,
      lng: longitude,
      speed: speed != null ? Number(speed) : null,
      heading: heading != null ? Number(heading) : null,
    });
    res.status(201).json({ message: 'Location updated.', location });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getBusLocation = async (req, res) => {
  try {
    if (req.user.role === 'parent') {
      const tripAccess = await Trip.findByPk(req.params.tripId, {
        attributes: ['id', 'routeId'],
        include: [{ model: Route, as: 'route', attributes: ['id', 'schoolId'] }],
      });
      if (!tripAccess || !await hasActiveParentSchool(req.user.id, tripAccess.route?.schoolId)) {
        return res.status(404).json({ error: 'Trip not found.' });
      }
      const childOnRoute = await Student.findOne({
        where: { parentId: req.user.id, schoolId: tripAccess.route.schoolId, isActive: true },
        include: [{
          model: Route,
          as: 'routes',
          where: { id: tripAccess.routeId },
          attributes: [],
          through: { attributes: [] },
          required: true,
        }],
      });
      if (!childOnRoute) return res.status(404).json({ error: 'Trip not found.' });
    }
    const loc = await BusLocation.findOne({ where: { tripId: req.params.tripId }, include: [
      { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','color'] },
      { model: User, as: 'driver', attributes: ['id','firstName','lastName','phone'] },
    ], order: [['recorded_at','DESC']] });
    if (!loc) return res.status(404).json({ error: 'No location data.' });
    const trip = await Trip.findByPk(req.params.tripId, { include: [{ model: Route, as: 'route', attributes: ['id','name'] }] });
    res.json({ location: { lat: parseFloat(loc.lat), lng: parseFloat(loc.lng), speed: loc.speed ? parseFloat(loc.speed) : null, heading: loc.heading ? parseFloat(loc.heading) : null, recordedAt: loc.recordedAt, vehicle: loc.vehicle, driver: loc.driver, trip: trip ? { id: trip.id, status: trip.status, type: trip.type, route: trip.route } : null } });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getLocationHistory = async (req, res) => {
  try {
    if (req.user.role === 'parent') {
      const tripAccess = await Trip.findByPk(req.params.tripId, {
        attributes: ['id', 'routeId'],
        include: [{ model: Route, as: 'route', attributes: ['id', 'schoolId'] }],
      });
      if (!tripAccess || !await hasActiveParentSchool(req.user.id, tripAccess.route?.schoolId)) {
        return res.status(404).json({ error: 'Trip not found.' });
      }
      const childOnRoute = await Student.findOne({
        where: { parentId: req.user.id, schoolId: tripAccess.route.schoolId, isActive: true },
        include: [{
          model: Route,
          as: 'routes',
          where: { id: tripAccess.routeId },
          attributes: [],
          through: { attributes: [] },
          required: true,
        }],
      });
      if (!childOnRoute) return res.status(404).json({ error: 'Trip not found.' });
    }
    const locs = await BusLocation.findAll({ where: { tripId: req.params.tripId }, attributes: ['lat','lng','speed','heading','recordedAt'], order: [['recorded_at','ASC']] });
    res.json({ locations: locs.map(l => ({ lat: parseFloat(l.lat), lng: parseFloat(l.lng), speed: l.speed ? parseFloat(l.speed) : null, recordedAt: l.recordedAt })), total: locs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getMyChildBus = async (req, res) => {
  try {
    const parentUser = await User.findByPk(req.user.id, { attributes: ['id','pickupLat','pickupLng','dropoffLat','dropoffLng'] });
    const activeSchoolIds = await getActiveParentSchoolIds(req.user.id);
    const children = await Student.findAll({ where: { parentId: req.user.id, schoolId: { [Op.in]: activeSchoolIds }, isActive: true }, include: [{ model: Route, as: 'routes', through: { attributes: ['stopOrder'] }, include: [
      { model: Trip, as: 'trips', where: { status: 'in_progress' }, required: false, include: [
        { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','color'] },
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
            const latest = await BusLocation.findOne({ where: { tripId: trip.id }, order: [['recorded_at','DESC']] });

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

            activeBuses.push({ tripId: trip.id, tripType: trip.type, routeName: route.name, routeSchool: route.school ? route.school.name : null, vehicle: trip.vehicle, driver: trip.driver, location: latest ? { lat: parseFloat(latest.lat), lng: parseFloat(latest.lng), speed: latest.speed ? parseFloat(latest.speed) : null, recordedAt: latest.recordedAt } : null, children: childrenEta, pendingStops });
          }
        }
      }
    }
    res.json({ activeBuses, total: activeBuses.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
