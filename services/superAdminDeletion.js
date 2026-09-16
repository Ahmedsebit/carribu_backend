const { Op } = require('sequelize');
const {
  sequelize,
  School,
  User,
  ParentSchool,
  Vehicle,
  Student,
  Route,
  RouteStudent,
  RouteWaypoint,
  Trip,
  TripLog,
  Message,
  BusLocation,
  AuditLog,
  Subscription,
} = require('../models');

const resourceLabels = {
  school: resource => resource.name,
  driver: resource => `${resource.firstName} ${resource.lastName}`.trim(),
  parent: resource => `${resource.firstName} ${resource.lastName}`.trim(),
  student: resource => `${resource.firstName} ${resource.lastName}`.trim(),
  vehicle: resource => resource.plateNumber,
  route: resource => resource.name,
  trip: resource => `Trip #${resource.id}`,
};

const normalizeConfirmation = value => String(value || '').trim().replace(/\s+/g, ' ');

const requireConfirmation = (confirmation, expected) => {
  if (normalizeConfirmation(confirmation) !== normalizeConfirmation(expected)) {
    const error = new Error(`Type "${expected}" to confirm permanent deletion.`);
    error.status = 400;
    throw error;
  }
};

const findActiveTrip = async (where, transaction) => Trip.findOne({
  where: { ...where, status: 'in_progress' },
  attributes: ['id'],
  transaction,
});

const blockActiveTrip = activeTrip => {
  if (!activeTrip) return;
  const error = new Error(`Trip #${activeTrip.id} is currently in progress. End it before deleting this resource.`);
  error.status = 409;
  throw error;
};

const deleteTrips = async (tripIds, transaction) => {
  const ids = [...new Set(tripIds.filter(Boolean))];
  if (ids.length === 0) return;
  await BusLocation.destroy({ where: { tripId: { [Op.in]: ids } }, transaction });
  await TripLog.destroy({ where: { tripId: { [Op.in]: ids } }, transaction });
  await Message.destroy({ where: { tripId: { [Op.in]: ids } }, transaction });
  await Trip.destroy({ where: { id: { [Op.in]: ids } }, transaction });
};

const deleteRoutes = async (routeIds, transaction) => {
  const ids = [...new Set(routeIds.filter(Boolean))];
  if (ids.length === 0) return;
  const trips = await Trip.findAll({
    where: { routeId: { [Op.in]: ids } },
    attributes: ['id'],
    transaction,
  });
  await deleteTrips(trips.map(trip => trip.id), transaction);
  await RouteStudent.destroy({ where: { routeId: { [Op.in]: ids } }, transaction });
  await RouteWaypoint.destroy({ where: { routeId: { [Op.in]: ids } }, transaction });
  await Route.destroy({ where: { id: { [Op.in]: ids } }, transaction });
};

const deleteStudents = async (studentIds, transaction) => {
  const ids = [...new Set(studentIds.filter(Boolean))];
  if (ids.length === 0) return;
  await TripLog.destroy({ where: { studentId: { [Op.in]: ids } }, transaction });
  await RouteStudent.destroy({ where: { studentId: { [Op.in]: ids } }, transaction });
  await Student.destroy({ where: { id: { [Op.in]: ids } }, transaction });
};

const deleteUsers = async (userIds, transaction) => {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return;
  await Message.destroy({
    where: {
      [Op.or]: [
        { senderId: { [Op.in]: ids } },
        { receiverId: { [Op.in]: ids } },
      ],
    },
    transaction,
  });
  await BusLocation.destroy({ where: { driverId: { [Op.in]: ids } }, transaction });
  await AuditLog.destroy({ where: { userId: { [Op.in]: ids } }, transaction });
  await School.update(
    { managedBy: null },
    { where: { managedBy: { [Op.in]: ids } }, transaction }
  );
  await ParentSchool.destroy({ where: { parentId: { [Op.in]: ids } }, transaction });
  await User.destroy({ where: { id: { [Op.in]: ids } }, transaction });
};

const preserveOrDeleteParent = async (parentId, deletedSchoolId, transaction) => {
  const [remainingMemberships, remainingStudentCount] = await Promise.all([
    ParentSchool.findAll({
      where: { parentId },
      attributes: ['schoolId', 'isActive'],
      order: [['isActive', 'DESC'], ['id', 'ASC']],
      transaction,
    }),
    Student.count({ where: { parentId }, transaction }),
  ]);

  if (remainingMemberships.length === 0 && remainingStudentCount === 0) {
    await deleteUsers([parentId], transaction);
    return;
  }

  const parent = await User.findByPk(parentId, { transaction });
  if (parent?.schoolId === deletedSchoolId) {
    await parent.update(
      { schoolId: remainingMemberships[0]?.schoolId || null },
      { transaction }
    );
  }
};

const deleteSchool = async (schoolId, confirmation) => sequelize.transaction(async transaction => {
  const school = await School.findByPk(schoolId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!school) {
    const error = new Error('School not found.');
    error.status = 404;
    throw error;
  }
  requireConfirmation(confirmation, resourceLabels.school(school));

  const routes = await Route.findAll({
    where: { schoolId: school.id },
    attributes: ['id'],
    transaction,
  });
  const routeIds = routes.map(route => route.id);
  blockActiveTrip(await findActiveTrip({ routeId: { [Op.in]: routeIds } }, transaction));

  const [students, vehicles, memberships, schoolUsers] = await Promise.all([
    Student.findAll({ where: { schoolId: school.id }, attributes: ['id'], transaction }),
    Vehicle.findAll({ where: { schoolId: school.id }, attributes: ['id'], transaction }),
    ParentSchool.findAll({ where: { schoolId: school.id }, attributes: ['parentId'], transaction }),
    User.findAll({ where: { schoolId: school.id }, attributes: ['id', 'role'], transaction }),
  ]);
  const parentIds = [...new Set([
    ...memberships.map(membership => membership.parentId),
    ...schoolUsers.filter(user => user.role === 'parent').map(user => user.id),
  ])];

  await Message.destroy({ where: { schoolId: school.id }, transaction });
  await AuditLog.destroy({ where: { schoolId: school.id }, transaction });
  await Subscription.destroy({ where: { schoolId: school.id }, transaction });
  await deleteRoutes(routeIds, transaction);
  await deleteStudents(students.map(student => student.id), transaction);
  await BusLocation.destroy({
    where: { vehicleId: { [Op.in]: vehicles.map(vehicle => vehicle.id) } },
    transaction,
  });
  await Vehicle.destroy({ where: { id: { [Op.in]: vehicles.map(vehicle => vehicle.id) } }, transaction });
  await ParentSchool.destroy({ where: { schoolId: school.id }, transaction });

  const nonParentUserIds = schoolUsers
    .filter(user => user.role !== 'parent')
    .map(user => user.id);
  await deleteUsers(nonParentUserIds, transaction);
  for (const parentId of parentIds) {
    await preserveOrDeleteParent(parentId, school.id, transaction);
  }

  await school.destroy({ transaction });
  return { message: `School "${school.name}" and all school-owned data were permanently deleted.` };
});

const loadSchoolResource = async (schoolId, type, resourceId, transaction) => {
  switch (type) {
    case 'driver':
      return User.findOne({ where: { id: resourceId, schoolId, role: 'driver' }, transaction });
    case 'parent':
      return User.findOne({
        where: { id: resourceId, role: 'parent' },
        include: [{
          model: ParentSchool,
          as: 'schoolMemberships',
          where: { schoolId },
          attributes: ['id', 'schoolId'],
          required: true,
        }],
        transaction,
      });
    case 'student':
      return Student.findOne({ where: { id: resourceId, schoolId }, transaction });
    case 'vehicle':
      return Vehicle.findOne({ where: { id: resourceId, schoolId }, transaction });
    case 'route':
      return Route.findOne({ where: { id: resourceId, schoolId }, transaction });
    case 'trip':
      return Trip.findOne({
        where: { id: resourceId },
        include: [{
          model: Route,
          as: 'route',
          where: { schoolId },
          attributes: ['id'],
          required: true,
        }],
        transaction,
      });
    default:
      return null;
  }
};

const deleteSchoolResource = async (schoolId, type, resourceId, confirmation) =>
  sequelize.transaction(async transaction => {
    const resource = await loadSchoolResource(schoolId, type, resourceId, transaction);
    if (!resource) {
      const error = new Error('Resource not found for this school.');
      error.status = 404;
      throw error;
    }
    const label = resourceLabels[type](resource);
    requireConfirmation(confirmation, label);

    if (type === 'trip') {
      blockActiveTrip(resource.status === 'in_progress' ? resource : null);
      await deleteTrips([resource.id], transaction);
    }

    if (type === 'route') {
      blockActiveTrip(await findActiveTrip({ routeId: resource.id }, transaction));
      await deleteRoutes([resource.id], transaction);
    }

    if (type === 'vehicle') {
      const routes = await Route.findAll({
        where: { schoolId, vehicleId: resource.id },
        attributes: ['id'],
        transaction,
      });
      const routeIds = routes.map(route => route.id);
      blockActiveTrip(await findActiveTrip({
        [Op.or]: [
          { vehicleId: resource.id },
          { routeId: { [Op.in]: routeIds } },
        ],
      }, transaction));
      await deleteRoutes(routeIds, transaction);
      const remainingTrips = await Trip.findAll({
        where: { vehicleId: resource.id },
        attributes: ['id'],
        transaction,
      });
      await deleteTrips(remainingTrips.map(trip => trip.id), transaction);
      await BusLocation.destroy({ where: { vehicleId: resource.id }, transaction });
      await resource.destroy({ transaction });
    }

    if (type === 'student') {
      const assignments = await RouteStudent.findAll({
        where: { studentId: resource.id },
        attributes: ['routeId'],
        transaction,
      });
      blockActiveTrip(await findActiveTrip({
        routeId: { [Op.in]: assignments.map(assignment => assignment.routeId) },
      }, transaction));
      await deleteStudents([resource.id], transaction);
    }

    if (type === 'parent') {
      const students = await Student.findAll({
        where: { schoolId, parentId: resource.id },
        attributes: ['id'],
        transaction,
      });
      const studentIds = students.map(student => student.id);
      const assignments = await RouteStudent.findAll({
        where: { studentId: { [Op.in]: studentIds } },
        attributes: ['routeId'],
        transaction,
      });
      blockActiveTrip(await findActiveTrip({
        routeId: { [Op.in]: assignments.map(assignment => assignment.routeId) },
      }, transaction));
      await Message.destroy({
        where: {
          schoolId,
          [Op.or]: [{ senderId: resource.id }, { receiverId: resource.id }],
        },
        transaction,
      });
      await deleteStudents(studentIds, transaction);
      await ParentSchool.destroy({ where: { parentId: resource.id, schoolId }, transaction });
      await preserveOrDeleteParent(resource.id, schoolId, transaction);
    }

    if (type === 'driver') {
      const routes = await Route.findAll({
        where: { schoolId, driverId: resource.id },
        attributes: ['id'],
        transaction,
      });
      const routeIds = routes.map(route => route.id);
      blockActiveTrip(await findActiveTrip({
        [Op.or]: [
          { driverId: resource.id },
          { routeId: { [Op.in]: routeIds } },
        ],
      }, transaction));
      await deleteRoutes(routeIds, transaction);
      const remainingTrips = await Trip.findAll({
        where: { driverId: resource.id },
        attributes: ['id'],
        transaction,
      });
      await deleteTrips(remainingTrips.map(trip => trip.id), transaction);
      await deleteUsers([resource.id], transaction);
    }

    return { message: `${type[0].toUpperCase()}${type.slice(1)} "${label}" was permanently deleted.` };
  });

module.exports = {
  deleteSchool,
  deleteSchoolResource,
  resourceLabels,
};
