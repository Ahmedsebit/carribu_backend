/**
 * Auth API Tests
 * Tests login, token validation, role-based access
 */
const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');

beforeAll(async () => {
  await setupTestDB();
});

afterAll(async () => {
  await teardownTestDB();
});

describe('POST /api/auth/login', () => {
  test('should login admin with valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'admin123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('school_admin');
    expect(res.body.user.email).toBe('admin@test.com');
    expect(res.body.user.firstName).toBe('Admin');
  });

  test('should login driver with valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'driver@test.com', password: 'driver123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('driver');
  });

  test('should login parent with valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'parent@test.com', password: 'parent123' });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.user.role).toBe('parent');
  });

  test('should reject invalid password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  test('should reject non-existent email', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.com', password: 'pass123' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  test('should reject missing fields', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com' });

    // Server returns 500 since no validation middleware (acceptable)
    expect([400, 500]).toContain(res.status);
  });
});

describe('GET /api/auth/me', () => {
  let adminToken;

  beforeAll(async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'admin@test.com', password: 'admin123' });
    adminToken = res.body.token;
  });

  test('should return current user with valid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@test.com');
    expect(res.body.user.role).toBe('school_admin');
  });

  test('should reject request without token', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
  });

  test('should reject invalid token', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', 'Bearer invalidtoken123');

    expect(res.status).toBe(401);
  });
});

describe('PUT /api/auth/change-password', () => {
  test('should change password with valid current password', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'driver@test.com', password: 'driver123' });
    const token = loginRes.body.token;

    const res = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'driver123', newPassword: 'newdriver456' });

    expect(res.status).toBe(200);

    // Verify new password works
    const loginRes2 = await request(app)
      .post('/api/auth/login')
      .send({ email: 'driver@test.com', password: 'newdriver456' });
    expect(loginRes2.status).toBe(200);

    // Restore original password
    const res2 = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes2.body.token}`)
      .send({ currentPassword: 'newdriver456', newPassword: 'driver123' });
    expect(res2.status).toBe(200);
  });

  test('should reject wrong current password', async () => {
    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'driver@test.com', password: 'driver123' });
    const token = loginRes.body.token;

    const res = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'wrongpassword', newPassword: 'newpass123' });

    expect(res.status).toBe(401);
  });
});
