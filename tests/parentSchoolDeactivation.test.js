const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');
const {
  User,
  ParentSchool,
  School,
  Student,
  Vehicle,
  Route,
  RouteStudent,
  Trip,
  Message,
} = require('../models');

let adminToken;
let parentToken;

const tomorrow = () => {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

beforeAll(async () => {
  await setupTestDB();
  const [adminResponse, parentResponse] = await Promise.all([
    request(app).post('/api/auth/login').send({ email: 'admin@test.com', password: 'admin123' }),
    request(app).post('/api/auth/login').send({ email: 'parent@test.com', password: 'parent123' }),
  ]);
  adminToken = adminResponse.body.token;
  parentToken = parentResponse.body.token;
});

afterAll(async () => {
  await teardownTestDB();
});

describe('Parent school deactivation', () => {
  test('removes only one school while preserving the account and other school trips', async () => {
    const { school, parent, student1 } = getTestData();
    const otherSchool = await School.create({ name: 'Second Active School' });
    const otherDriver = await User.create({
      schoolId: otherSchool.id,
      email: 'other-school-driver@test.com',
      passwordHash: 'driver123',
      firstName: 'Other',
      lastName: 'Driver',
      role: 'driver',
      phone: '+254733444555',
    });
    const otherVehicle = await Vehicle.create({
      schoolId: otherSchool.id,
      plateNumber: 'KDB 123A',
      capacity: 20,
      status: 'active',
    });
    const otherStudent = await Student.create({
      schoolId: otherSchool.id,
      parentId: parent.id,
      admissionNumber: 'OTHER-001',
      firstName: 'Other',
      lastName: 'Child',
      grade: 'Grade 4',
    });
    const otherRoute = await Route.create({
      schoolId: otherSchool.id,
      name: 'Other School Route',
      vehicleId: otherVehicle.id,
      driverId: otherDriver.id,
      type: 'both',
    });
    await RouteStudent.create({ routeId: otherRoute.id, studentId: otherStudent.id, stopOrder: 1 });
    await Trip.create({
      routeId: otherRoute.id,
      driverId: otherDriver.id,
      vehicleId: otherVehicle.id,
      type: 'morning_pickup',
      status: 'scheduled',
      scheduledDate: tomorrow(),
      scheduledTime: '07:00',
    });
    const oldSchoolNotification = await Message.create({
      schoolId: school.id,
      senderId: getTestData().driver.id,
      receiverId: parent.id,
      content: 'Old school trip alert.',
      messageType: 'alert',
    });
    const otherSchoolNotification = await Message.create({
      schoolId: otherSchool.id,
      senderId: otherDriver.id,
      receiverId: parent.id,
      content: 'Other school trip alert.',
      messageType: 'alert',
    });
    await ParentSchool.findOrCreate({
      where: { parentId: parent.id, schoolId: otherSchool.id },
      defaults: { isActive: true },
    });

    const deleteResponse = await request(app)
      .delete(`/api/parents/${parent.id}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(deleteResponse.status).toBe(200);
    expect(deleteResponse.body.message).toMatch(/access.*deactivated/i);

    const [account, originalStudent, oldMembership, otherMembership] = await Promise.all([
      User.findByPk(parent.id),
      Student.findByPk(student1.id),
      ParentSchool.findOne({ where: { parentId: parent.id, schoolId: school.id } }),
      ParentSchool.findOne({ where: { parentId: parent.id, schoolId: otherSchool.id } }),
    ]);
    expect(account.isActive).toBe(true);
    expect(originalStudent.parentId).toBe(parent.id);
    expect(oldMembership.isActive).toBe(false);
    expect(otherMembership.isActive).toBe(true);

    const loginResponse = await request(app)
      .post('/api/auth/login')
      .send({ email: 'parent@test.com', password: 'parent123' });
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.body.user.parentSchools).toEqual([
      expect.objectContaining({ id: otherSchool.id, name: otherSchool.name }),
    ]);
    expect(loginResponse.body.user.school).toBeNull();

    const tripsResponse = await request(app)
      .get('/api/parent/upcoming-trips')
      .query({ days: 7 })
      .set('Authorization', `Bearer ${parentToken}`);
    expect(tripsResponse.status).toBe(200);
    expect(tripsResponse.body.trips).toHaveLength(1);
    expect(tripsResponse.body.trips[0].school.id).toBe(otherSchool.id);
    expect(tripsResponse.body.filters.schools).toEqual([
      expect.objectContaining({ id: otherSchool.id }),
    ]);

    const studentsResponse = await request(app)
      .get('/api/students')
      .set('Authorization', `Bearer ${parentToken}`);
    expect(studentsResponse.status).toBe(200);
    expect(studentsResponse.body.students.map(student => student.id)).toEqual([otherStudent.id]);

    const notificationsResponse = await request(app)
      .get('/api/messages/notifications')
      .set('Authorization', `Bearer ${parentToken}`);
    expect(notificationsResponse.status).toBe(200);
    expect(notificationsResponse.body.notifications.map(notification => notification.id))
      .toContain(otherSchoolNotification.id);
    expect(notificationsResponse.body.notifications.map(notification => notification.id))
      .not.toContain(oldSchoolNotification.id);

    const inactiveListResponse = await request(app)
      .get('/api/parents')
      .set('Authorization', `Bearer ${adminToken}`);
    const inactiveParent = inactiveListResponse.body.parents.find(item => item.id === parent.id);
    expect(inactiveParent.schoolAccessActive).toBe(false);

    const reactivateResponse = await request(app)
      .put(`/api/parents/${parent.id}/reactivate`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(reactivateResponse.status).toBe(200);
    expect(reactivateResponse.body.message).toMatch(/reactivated/i);

    const restoredMembership = await ParentSchool.findOne({
      where: { parentId: parent.id, schoolId: school.id },
    });
    expect(restoredMembership.isActive).toBe(true);

    const restoredTripsResponse = await request(app)
      .get('/api/parent/upcoming-trips')
      .query({ days: 7 })
      .set('Authorization', `Bearer ${parentToken}`);
    expect(restoredTripsResponse.body.filters.schools).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: school.id }),
      expect.objectContaining({ id: otherSchool.id }),
    ]));
  });
});
