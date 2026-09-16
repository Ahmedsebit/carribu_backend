const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');
const { School, User, Student } = require('../models');

let adminToken;

beforeAll(async () => {
  await setupTestDB();
  const loginResponse = await request(app)
    .post('/api/auth/login')
    .send({ email: 'admin@test.com', password: 'admin123' });
  adminToken = loginResponse.body.token;
});

afterAll(async () => {
  await teardownTestDB();
});

describe('Student parent linking', () => {
  test('links and unlinks an active parent from the same school', async () => {
    const { parent } = getTestData();
    const createResponse = await request(app)
      .post('/api/students')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        admissionNumber: 'LINK-001',
        firstName: 'Linked',
        lastName: 'Student',
        grade: 'Grade 2',
        parentId: parent.id,
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body.student.parentId).toBe(parent.id);

    const unlinkResponse = await request(app)
      .put(`/api/students/${createResponse.body.student.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ parentId: null });

    expect(unlinkResponse.status).toBe(200);
    await expect(Student.findByPk(createResponse.body.student.id))
      .resolves.toMatchObject({ parentId: null });
  });

  test('rejects a parent who does not have active access to the school', async () => {
    const otherSchool = await School.create({ name: 'Other Parent School' });
    const otherParent = await User.create({
      schoolId: otherSchool.id,
      email: 'other-parent-link@test.com',
      passwordHash: 'parent123',
      firstName: 'Other',
      lastName: 'Parent',
      role: 'parent',
      phone: '+254733222111',
    });

    const response = await request(app)
      .post('/api/students')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        admissionNumber: 'LINK-002',
        firstName: 'Wrong',
        lastName: 'School',
        parentId: otherParent.id,
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/not active in this school/i);
    await expect(Student.findOne({ where: { admissionNumber: 'LINK-002' } }))
      .resolves.toBeNull();
  });
});
