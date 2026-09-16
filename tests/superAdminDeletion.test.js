const { setupTestDB, teardownTestDB, getTestData } = require('./setup');
const {
  School,
  User,
  ParentSchool,
  Vehicle,
  Student,
  Route,
  RouteStudent,
  Trip,
  TripLog,
  Message,
  BusLocation,
  Subscription,
} = require('../models');
const {
  deleteSchool,
  deleteSchoolResource,
} = require('../services/superAdminDeletion');

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

describe('Super Admin permanent deletion', () => {
  test('requires exact typed confirmation', async () => {
    const { school } = getTestData();
    await expect(deleteSchool(school.id, 'wrong name')).rejects.toMatchObject({ status: 400 });
    await expect(School.findByPk(school.id)).resolves.not.toBeNull();
  });

  test('blocks deletion when a related trip is in progress', async () => {
    const { school, route, driver, vehicle } = getTestData();
    const trip = await Trip.create({
      routeId: route.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      type: 'morning_pickup',
      status: 'in_progress',
      scheduledDate: '2026-09-16',
    });

    await expect(
      deleteSchoolResource(school.id, 'route', route.id, route.name)
    ).rejects.toMatchObject({ status: 409 });
    await expect(Route.findByPk(route.id)).resolves.not.toBeNull();

    await trip.update({ status: 'completed' });
  });

  test('cannot delete a resource owned by another school', async () => {
    const { school } = getTestData();
    const otherSchool = await School.create({ name: 'Foreign Resource School' });
    const otherVehicle = await Vehicle.create({
      schoolId: otherSchool.id,
      plateNumber: 'KDD 987C',
      capacity: 10,
    });

    await expect(
      deleteSchoolResource(school.id, 'vehicle', otherVehicle.id, otherVehicle.plateNumber)
    ).rejects.toMatchObject({ status: 404 });
    await expect(Vehicle.findByPk(otherVehicle.id)).resolves.not.toBeNull();
  });

  test('permanently deletes individual resources and their dependent records', async () => {
    const { school, route, driver, vehicle, parent } = getTestData();

    const trip = await Trip.create({
      routeId: route.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      type: 'morning_pickup',
      status: 'completed',
      scheduledDate: '2026-09-15',
    });
    await Promise.all([
      Message.create({
        schoolId: school.id,
        senderId: driver.id,
        receiverId: parent.id,
        tripId: trip.id,
        content: 'Trip message',
      }),
      BusLocation.create({
        tripId: trip.id,
        vehicleId: vehicle.id,
        driverId: driver.id,
        lat: -1.2,
        lng: 36.8,
      }),
    ]);

    await deleteSchoolResource(school.id, 'trip', trip.id, `  Trip   #${trip.id}  `);
    await expect(Trip.findByPk(trip.id)).resolves.toBeNull();
    await expect(Message.count({ where: { tripId: trip.id } })).resolves.toBe(0);
    await expect(BusLocation.count({ where: { tripId: trip.id } })).resolves.toBe(0);

    const student = await Student.create({
      schoolId: school.id,
      parentId: parent.id,
      admissionNumber: 'DELETE-STUDENT',
      firstName: 'Delete',
      lastName: 'Student',
    });
    await RouteStudent.create({ routeId: route.id, studentId: student.id, stopOrder: 3 });
    const completedTrip = await Trip.create({
      routeId: route.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
      type: 'morning_pickup',
      status: 'completed',
      scheduledDate: '2026-09-14',
    });
    await TripLog.create({
      tripId: completedTrip.id,
      studentId: student.id,
      action: 'check_in',
    });

    await deleteSchoolResource(
      school.id,
      'student',
      student.id,
      'Delete Student'
    );
    await expect(Student.findByPk(student.id)).resolves.toBeNull();
    await expect(RouteStudent.count({ where: { studentId: student.id } })).resolves.toBe(0);
    await expect(TripLog.count({ where: { studentId: student.id } })).resolves.toBe(0);

    const disposableParent = await User.create({
      schoolId: school.id,
      email: 'delete-parent@test.com',
      passwordHash: 'password',
      firstName: 'Delete',
      lastName: 'Parent',
      role: 'parent',
      phone: '+254744555666',
    });
    const parentStudent = await Student.create({
      schoolId: school.id,
      parentId: disposableParent.id,
      admissionNumber: 'DELETE-PARENT-CHILD',
      firstName: 'Parent',
      lastName: 'Child',
    });
    await deleteSchoolResource(
      school.id,
      'parent',
      disposableParent.id,
      'Delete Parent'
    );
    await expect(User.findByPk(disposableParent.id)).resolves.toBeNull();
    await expect(Student.findByPk(parentStudent.id)).resolves.toBeNull();

    const disposableVehicle = await Vehicle.create({
      schoolId: school.id,
      plateNumber: 'KDC 456B',
      capacity: 12,
    });
    const vehicleRoute = await Route.create({
      schoolId: school.id,
      name: 'Delete Vehicle Route',
      vehicleId: disposableVehicle.id,
      driverId: driver.id,
    });
    const vehicleTrip = await Trip.create({
      routeId: vehicleRoute.id,
      driverId: driver.id,
      vehicleId: disposableVehicle.id,
      type: 'morning_pickup',
      status: 'scheduled',
      scheduledDate: '2026-09-17',
    });
    await deleteSchoolResource(
      school.id,
      'vehicle',
      disposableVehicle.id,
      disposableVehicle.plateNumber
    );
    await expect(Vehicle.findByPk(disposableVehicle.id)).resolves.toBeNull();
    await expect(Route.findByPk(vehicleRoute.id)).resolves.toBeNull();
    await expect(Trip.findByPk(vehicleTrip.id)).resolves.toBeNull();

    const disposableDriver = await User.create({
      schoolId: school.id,
      email: 'delete-driver-resource@test.com',
      passwordHash: 'password',
      firstName: 'Delete',
      lastName: 'Driver',
      role: 'driver',
      phone: '+254755666777',
    });
    const driverRoute = await Route.create({
      schoolId: school.id,
      name: 'Delete Driver Route',
      vehicleId: vehicle.id,
      driverId: disposableDriver.id,
    });
    await deleteSchoolResource(
      school.id,
      'driver',
      disposableDriver.id,
      'Delete Driver'
    );
    await expect(User.findByPk(disposableDriver.id)).resolves.toBeNull();
    await expect(Route.findByPk(driverRoute.id)).resolves.toBeNull();
  });

  test('deletes a school graph while preserving a parent linked to another school', async () => {
    const { school, admin, driver, parent, route, vehicle, student1 } = getTestData();
    const otherSchool = await School.create({ name: 'Preserved School' });
    await ParentSchool.findOrCreate({
      where: { parentId: parent.id, schoolId: otherSchool.id },
    });
    const preservedStudent = await Student.create({
      schoolId: otherSchool.id,
      parentId: parent.id,
      admissionNumber: 'PRESERVED-001',
      firstName: 'Preserved',
      lastName: 'Child',
    });
    await Subscription.create({ schoolId: school.id, plan: 'premium' });
    const trip = await Trip.create({
      routeId: route.id,
      driverId: getTestData().driver.id,
      vehicleId: vehicle.id,
      type: 'afternoon_dropoff',
      status: 'completed',
      scheduledDate: '2026-09-13',
    });
    await Message.create({
      schoolId: school.id,
      senderId: getTestData().driver.id,
      receiverId: parent.id,
      tripId: trip.id,
      content: 'School deletion message',
    });

    await deleteSchool(school.id, school.name);

    await expect(School.findByPk(school.id)).resolves.toBeNull();
    await expect(Route.count({ where: { schoolId: school.id } })).resolves.toBe(0);
    await expect(Vehicle.count({ where: { schoolId: school.id } })).resolves.toBe(0);
    await expect(Student.findByPk(student1.id)).resolves.toBeNull();
    await expect(Message.count({ where: { schoolId: school.id } })).resolves.toBe(0);
    await expect(Subscription.count({ where: { schoolId: school.id } })).resolves.toBe(0);
    await expect(User.findByPk(admin.id)).resolves.toBeNull();
    await expect(User.findByPk(driver.id)).resolves.toBeNull();
    await expect(ParentSchool.count({ where: { schoolId: school.id } })).resolves.toBe(0);

    const preservedParent = await User.findByPk(parent.id);
    expect(preservedParent).not.toBeNull();
    expect(preservedParent.schoolId).toBe(otherSchool.id);
    await expect(Student.findByPk(preservedStudent.id)).resolves.not.toBeNull();
    await expect(ParentSchool.findOne({
      where: { parentId: parent.id, schoolId: otherSchool.id },
    })).resolves.not.toBeNull();
  });
});
