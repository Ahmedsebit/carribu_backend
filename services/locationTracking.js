const { Op } = require('sequelize');
const { BusLocation, Trip, Vehicle, Route, User, Student, TripLog, Message } = require('../models');
const { notifyTrip, notifyUser } = require('../socket');
const { getActiveParentIdsForSchool } = require('../utils/parentSchoolAccess');

const getLocationSource = vehicle => vehicle.trackerUniqueId?.trim() ? 'traccar' : 'phone';

async function getTripLocationWhere(trip) {
  const where = { tripId: trip.id };
  if (trip.status === 'in_progress') {
    const vehicle = trip.vehicle || await Vehicle.findByPk(trip.vehicleId);
    if (!vehicle) throw Object.assign(new Error('Trip vehicle not found.'), { status: 404 });
    where.source = getLocationSource(vehicle);
  }
  return where;
}

async function recordDriverLocation({ tripId, lat, lng, speed, heading } = {}, user) {
  if (!['driver', 'coordinator', 'school_admin'].includes(user.role)) {
    throw Object.assign(new Error('Only the assigned driver can update a trip location.'), { status: 403 });
  }
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!tripId || lat == null || lng == null || lat === '' || lng === ''
    || !Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw Object.assign(new Error('A tripId and valid lat/lng coordinates are required.'), { status: 400 });
  }
  const trip = await Trip.findOne({
    where: { id: tripId, driverId: user.id, status: 'in_progress' },
    include: [
      { model: Vehicle, as: 'vehicle', attributes: ['id', 'trackerUniqueId'] },
      { model: Route, as: 'route', where: { schoolId: user.schoolId }, attributes: ['schoolId'], required: true },
    ],
  });
  if (!trip || !trip.vehicle) {
    throw Object.assign(new Error('Active trip not found.'), { status: 404 });
  }
  if (getLocationSource(trip.vehicle) === 'traccar') {
    throw Object.assign(new Error('This trip uses its linked Traccar device. Phone GPS sharing must stop.'), {
      status: 409, code: 'TRACCAR_LOCATION_REQUIRED',
    });
  }
  return recordLocation({
    trip, schoolId: user.schoolId, driverId: user.id,
    lat: latitude, lng: longitude,
    speed: speed == null ? null : Number(speed),
    heading: heading == null ? null : Number(heading),
    source: 'phone',
  });
}

const toRadians = deg => deg * Math.PI / 180;
const distanceInMeters = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

async function recordLocation({
  trip,
  schoolId,
  driverId,
  lat,
  lng,
  speed,
  heading,
  recordedAt = new Date(),
  trackerPositionId = null,
  source = 'phone',
}) {
  const values = {
    tripId: trip.id,
    vehicleId: trip.vehicleId,
    driverId: driverId || trip.driverId || null,
    lat,
    lng,
    speed,
    heading,
    recordedAt,
    trackerPositionId,
    source,
  };
  let location;
  let created = true;
  if (trackerPositionId != null) {
    [location, created] = await BusLocation.findOrCreate({
      where: { trackerPositionId },
      defaults: values,
    });
  } else {
    location = await BusLocation.create(values);
  }
  if (!created) return { location, created };

  notifyTrip(trip.id, 'location-update', {
    tripId: trip.id,
    driverId: values.driverId,
    lat,
    lng,
    speed,
    heading,
    timestamp: recordedAt.getTime(),
    source,
  });

  const route = await Route.findByPk(trip.routeId, {
    include: [{
      model: Student,
      as: 'students',
      through: { attributes: ['stopOrder'] },
      include: [{
        model: User,
        as: 'parent',
        attributes: ['id', 'firstName', 'lastName', 'phone', 'email', 'pickupAddress', 'pickupLat', 'pickupLng'],
      }],
    }],
  });
  if (!route) return { location, created };

  const activeParentIds = await getActiveParentIdsForSchool(
    (route.students || []).map(student => student.parent?.id),
    schoolId
  );
  const logs = await TripLog.findAll({ where: { tripId: trip.id }, order: [['created_at', 'DESC']] });
  const latestAction = logs.reduce((actions, log) => {
    if (!actions[log.studentId]) actions[log.studentId] = log.action;
    return actions;
  }, {});
  const pendingStudents = (route.students || []).filter(student => {
    const action = latestAction[student.id];
    return !['absent', 'check_out', 'check_in'].includes(action)
      && student.parent
      && activeParentIds.has(student.parent.id)
      && student.parent.pickupLat
      && student.parent.pickupLng;
  });

  const speedKmh = speed > 0 ? speed : 30;
  for (const student of pendingStudents) {
    const distance = distanceInMeters(lat, lng, Number(student.parent.pickupLat), Number(student.parent.pickupLng));
    const stopsBefore = pendingStudents.filter(
      candidate => candidate.RouteStudent.stopOrder < student.RouteStudent.stopOrder
    ).length;
    const totalMinutes = Math.round(((distance / 1000) / speedKmh) * 60 + stopsBefore * 3);
    if (totalMinutes <= 5 && totalMinutes > 0) {
      const content = `⏱️ Bus is ~${totalMinutes} min away from ${student.firstName}'s stop! ${
        stopsBefore > 0
          ? `(${stopsBefore} stop${stopsBefore > 1 ? 's' : ''} before yours)`
          : 'You are next!'
      }`;
      const recent = await Message.findOne({
        where: {
          receiverId: student.parent.id,
          senderId: values.driverId,
          tripId: trip.id,
          messageType: 'system',
          content: { [Op.like]: `%min away from ${student.firstName}%` },
        },
        order: [['created_at', 'DESC']],
      });
      if (!recent || new Date() - new Date(recent.createdAt) > 5 * 60 * 1000) {
        await Message.create({
          schoolId,
          senderId: values.driverId,
          receiverId: student.parent.id,
          tripId: trip.id,
          content,
          messageType: 'system',
        });
        notifyUser(student.parent.id, 'driver-approaching', {
          tripId: trip.id,
          studentName: student.firstName,
          etaMinutes: totalMinutes,
          message: content,
        });
      }
    }
  }

  if (pendingStudents.length > 0) {
    const nearest = pendingStudents.map(student => ({
      student,
      distance: distanceInMeters(
        lat,
        lng,
        Number(student.parent.pickupLat),
        Number(student.parent.pickupLng)
      ),
    })).sort((left, right) => left.distance - right.distance)[0];
    if (nearest?.distance <= 200) {
      const parent = nearest.student.parent;
      const content = `🚍 Driver is approaching ${nearest.student.firstName} ${nearest.student.lastName}'s pickup point. Expected arrival soon.`;
      const recent = await Message.findOne({
        where: {
          receiverId: parent.id,
          senderId: values.driverId,
          tripId: trip.id,
          messageType: 'arrival',
        },
        order: [['created_at', 'DESC']],
      });
      if (!recent || new Date() - new Date(recent.createdAt) > 10 * 60 * 1000) {
        await Message.create({
          schoolId,
          senderId: values.driverId,
          receiverId: parent.id,
          tripId: trip.id,
          content,
          messageType: 'arrival',
        });
        notifyUser(parent.id, 'driver-approaching', {
          tripId: trip.id,
          studentName: nearest.student.firstName,
          message: content,
        });
      }
    }
  }

  return { location, created };
}

module.exports = { distanceInMeters, recordLocation, recordDriverLocation, getLocationSource, getTripLocationWhere };
