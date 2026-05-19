const { BusLocation, Trip, Route, Vehicle, User, Student, TripLog, Message, School } = require('../models');
const toRadians = deg => deg * Math.PI / 180;
const distanceInMeters = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};
exports.updateLocation = async (req, res) => {
  try {
    const { tripId, lat, lng, speed, heading } = req.body;
    if (!tripId || !lat || !lng) return res.status(400).json({ error: 'tripId, lat, lng required.' });
    const trip = await Trip.findOne({ where: { id: tripId, driverId: req.user.id, status: 'in_progress' } });
    if (!trip) return res.status(404).json({ error: 'Active trip not found.' });
    const loc = await BusLocation.create({ tripId, vehicleId: trip.vehicleId, driverId: req.user.id, lat, lng, speed, heading, recordedAt: new Date() });

    const route = await Route.findByPk(trip.routeId, { include: [{ model: Student, as: 'students', through: { attributes: ['stopOrder'] }, include: [{ model: User, as: 'parent', attributes: ['id','firstName','lastName','phone','email'] }] }] });
    if (route) {
      const logs = await TripLog.findAll({ where: { tripId }, order: [['created_at','DESC']] });
      const latestAction = logs.reduce((acc, log) => {
        if (!acc[log.studentId]) acc[log.studentId] = log.action;
        return acc;
      }, {});
      const pendingStudents = (route.students || []).filter(s => {
        const action = latestAction[s.id];
        return action !== 'absent' && action !== 'check_out' && action !== 'check_in';
      }).filter(s => s.pickupLat && s.pickupLng && s.parent);

      // Notify parents when bus is ~5 minutes away from their child
      const DEFAULT_SPEED_KMH = 30;
      const STOP_BUFFER_MINUTES = 3;
      const speedKmh = (speed && parseFloat(speed) > 0) ? parseFloat(speed) : DEFAULT_SPEED_KMH;
      for (const student of pendingStudents) {
        const dist = distanceInMeters(parseFloat(lat), parseFloat(lng), parseFloat(student.pickupLat), parseFloat(student.pickupLng));
        const stopsBefore = pendingStudents.filter(s => s.RouteStudent.stopOrder < student.RouteStudent.stopOrder).length;
        const travelMin = ((dist / 1000) / speedKmh) * 60;
        const totalMin = Math.round(travelMin + (stopsBefore * STOP_BUFFER_MINUTES));

        if (totalMin <= 5 && totalMin > 0) {
          const content = `⏱️ Bus is ~${totalMin} min away from ${student.firstName}'s stop! ${stopsBefore > 0 ? `(${stopsBefore} stop${stopsBefore > 1 ? 's' : ''} before yours)` : 'You are next!'}`;
          const recent = await Message.findOne({ where: { receiverId: student.parent.id, senderId: req.user.id, tripId, messageType: 'system', content: { [require('sequelize').Op.like]: '%min away from ' + student.firstName + '%' } }, order: [['created_at','DESC']] });
          if (!recent || (new Date() - new Date(recent.createdAt)) > 5 * 60 * 1000) {
            await Message.create({ schoolId: req.user.schoolId, senderId: req.user.id, receiverId: student.parent.id, tripId, content, messageType: 'system' });
          }
        }
      }

      // Notify nearest parent when bus is within 200m
      if (pendingStudents.length > 0) {
        const nearest = pendingStudents.map(s => ({
          student: s,
          distance: distanceInMeters(parseFloat(lat), parseFloat(lng), parseFloat(s.pickupLat), parseFloat(s.pickupLng)),
        })).sort((a, b) => a.distance - b.distance)[0];
        if (nearest && nearest.distance <= 200) {
          const parent = nearest.student.parent;
          const content = `🚍 Driver is approaching ${nearest.student.firstName} ${nearest.student.lastName}'s pickup point. Expected arrival soon.`;
          const recent = await Message.findOne({ where: { receiverId: parent.id, senderId: req.user.id, tripId, messageType: 'arrival' }, order: [['created_at','DESC']] });
          if (!recent || (new Date() - new Date(recent.createdAt)) > 10 * 60 * 1000) {
            await Message.create({ schoolId: req.user.schoolId, senderId: req.user.id, receiverId: parent.id, tripId, content, messageType: 'arrival' });
          }
        }
      }
    }

    res.status(201).json({ message: 'Location updated.', location: loc });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getBusLocation = async (req, res) => {
  try {
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
    const locs = await BusLocation.findAll({ where: { tripId: req.params.tripId }, attributes: ['lat','lng','speed','heading','recordedAt'], order: [['recorded_at','ASC']] });
    res.json({ locations: locs.map(l => ({ lat: parseFloat(l.lat), lng: parseFloat(l.lng), speed: l.speed ? parseFloat(l.speed) : null, recordedAt: l.recordedAt })), total: locs.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
exports.getMyChildBus = async (req, res) => {
  try {
    const children = await Student.findAll({ where: { parentId: req.user.id }, include: [{ model: Route, as: 'routes', through: { attributes: ['stopOrder'] }, include: [
      { model: Trip, as: 'trips', where: { status: 'in_progress' }, required: false, include: [
        { model: Vehicle, as: 'vehicle', attributes: ['id','plateNumber','make','model','color'] },
        { model: User, as: 'driver', attributes: ['id','firstName','lastName','phone'] },
      ] },
      { model: School, as: 'school', attributes: ['id','name'] },
      { model: Student, as: 'students', through: { attributes: ['stopOrder'] } },
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

              if (latest && c.pickupLat && c.pickupLng) {
                const busLat = parseFloat(latest.lat);
                const busLng = parseFloat(latest.lng);
                const childLat = parseFloat(c.pickupLat);
                const childLng = parseFloat(c.pickupLng);
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

            activeBuses.push({ tripId: trip.id, tripType: trip.type, routeName: route.name, routeSchool: route.school ? route.school.name : null, vehicle: trip.vehicle, driver: trip.driver, location: latest ? { lat: parseFloat(latest.lat), lng: parseFloat(latest.lng), speed: latest.speed ? parseFloat(latest.speed) : null, recordedAt: latest.recordedAt } : null, children: childrenEta });
          }
        }
      }
    }
    res.json({ activeBuses, total: activeBuses.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
};
