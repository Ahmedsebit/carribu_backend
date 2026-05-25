/**
 * Test setup - initializes DB and seeds test data
 */
const { sequelize, School, User, Vehicle, Student, Route, RouteStudent, Trip } = require('../models');

let testData = {};

async function setupTestDB() {
  await sequelize.authenticate();
  await sequelize.sync({ force: true });

  // Create school
  const school = await School.create({
    name: 'Test Academy',
    address: '123 Test Street',
    city: 'Nairobi',
    phone: '+254700000000',
    email: 'admin@testacademy.co.ke',
  });

  // Create admin
  const admin = await User.create({
    schoolId: school.id,
    email: 'admin@test.com',
    passwordHash: 'admin123',
    firstName: 'Admin',
    lastName: 'User',
    role: 'admin',
    phone: '+254700000001',
  });

  // Create driver
  const driver = await User.create({
    schoolId: school.id,
    email: 'driver@test.com',
    passwordHash: 'driver123',
    firstName: 'Test',
    lastName: 'Driver',
    role: 'driver',
    phone: '+254700000002',
  });

  // Create parent
  const parent = await User.create({
    schoolId: school.id,
    email: 'parent@test.com',
    passwordHash: 'parent123',
    firstName: 'Test',
    lastName: 'Parent',
    role: 'parent',
    phone: '+254700000003',
    pickupLat: -1.2641,
    pickupLng: 36.8053,
    pickupAddress: 'Westlands, Nairobi',
  });

  // Create second parent
  const parent2 = await User.create({
    schoolId: school.id,
    email: 'parent2@test.com',
    passwordHash: 'parent123',
    firstName: 'Second',
    lastName: 'Parent',
    role: 'parent',
    phone: '+254700000004',
    pickupLat: -1.2888,
    pickupLng: 36.7845,
    pickupAddress: 'Kilimani, Nairobi',
  });

  // Create vehicle
  const vehicle = await Vehicle.create({
    schoolId: school.id,
    plateNumber: 'KDA 999T',
    make: 'Toyota',
    model: 'HiAce',
    year: 2022,
    capacity: 18,
    color: 'White',
    status: 'active',
    insuranceExpiry: '2027-12-31',
  });

  // Create students
  const student1 = await Student.create({
    schoolId: school.id,
    parentId: parent.id,
    firstName: 'Child',
    lastName: 'One',
    grade: 'Grade 3',
  });

  const student2 = await Student.create({
    schoolId: school.id,
    parentId: parent2.id,
    firstName: 'Child',
    lastName: 'Two',
    grade: 'Grade 3',
  });

  // Create route
  const route = await Route.create({
    schoolId: school.id,
    name: 'Test Route',
    description: 'Test route for e2e',
    vehicleId: vehicle.id,
    driverId: driver.id,
    type: 'both',
  });

  // Assign students to route
  await RouteStudent.bulkCreate([
    { routeId: route.id, studentId: student1.id, stopOrder: 1 },
    { routeId: route.id, studentId: student2.id, stopOrder: 2 },
  ]);

  testData = { school, admin, driver, parent, parent2, vehicle, student1, student2, route };
  return testData;
}

async function teardownTestDB() {
  // Don't close the connection - let Jest --forceExit handle cleanup
  // This allows multiple test files to run in the same process
}

function getTestData() {
  return testData;
}

module.exports = { setupTestDB, teardownTestDB, getTestData };
