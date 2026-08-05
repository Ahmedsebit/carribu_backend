/**
 * Focused login tests: credentials, phone-number login, deactivated accounts,
 * and role-based gating (both the backend `authorize` middleware and the
 * per-app login gate the mobile apps apply after authentication).
 *
 * Self-contained: creates its own users under a dedicated school with unique
 * emails/phones and cleans them up, so it can run alongside the other suites
 * that share the same test database without force-syncing.
 */
const request = require('supertest');
const app = require('./testApp');
const { sequelize, School, User } = require('../models');

// Unique-ish identifiers so this suite never collides with the others.
const ADMIN_EMAIL = 'gate-admin@login.test';
const DRIVER_EMAIL = 'gate-driver@login.test';
const COORD_EMAIL = 'gate-coord@login.test';
const PARENT_EMAIL = 'gate-parent@login.test';
const INACTIVE_EMAIL = 'gate-inactive@login.test';
const PARENT_PHONE = '+254799000004';
const EMAILS = [ADMIN_EMAIL, DRIVER_EMAIL, COORD_EMAIL, PARENT_EMAIL, INACTIVE_EMAIL];

let school;

async function login(body) {
  return request(app).post('/api/auth/login').send(body);
}

async function tokenFor(email, password) {
  const res = await login({ email, password });
  return res.body.token;
}

beforeAll(async () => {
  await sequelize.authenticate();
  await sequelize.sync(); // ensure tables exist without dropping sibling data

  // Clean any leftovers from a previous run.
  await User.destroy({ where: { email: EMAILS } });
  await School.destroy({ where: { email: 'login-gate@school.test' } });

  school = await School.create({
    name: 'Login Gate School', address: '1 Gate St', city: 'Nairobi',
    phone: '+254799000000', email: 'login-gate@school.test',
  });

  await User.bulkCreate([
    { schoolId: school.id, email: ADMIN_EMAIL, passwordHash: 'admin123', firstName: 'Gate', lastName: 'Admin', role: 'school_admin', phone: '+254799000001' },
    { schoolId: school.id, email: DRIVER_EMAIL, passwordHash: 'driver123', firstName: 'Gate', lastName: 'Driver', role: 'driver', phone: '+254799000002' },
    { schoolId: school.id, email: COORD_EMAIL, passwordHash: 'coord123', firstName: 'Gate', lastName: 'Coord', role: 'coordinator', phone: '+254799000003' },
    { schoolId: school.id, email: PARENT_EMAIL, passwordHash: 'parent123', firstName: 'Gate', lastName: 'Parent', role: 'parent', phone: PARENT_PHONE, pickupLat: -1.2641, pickupLng: 36.8053, pickupAddress: 'Westlands' },
    { schoolId: school.id, email: INACTIVE_EMAIL, passwordHash: 'parent123', firstName: 'Gone', lastName: 'Parent', role: 'parent', phone: '+254799000005', isActive: false },
  ], { individualHooks: true }); // individualHooks so password hashing runs per row
});

afterAll(async () => {
  await User.destroy({ where: { email: EMAILS } });
  if (school) await School.destroy({ where: { id: school.id } });
});

describe('Login — credentials', () => {
  test('valid email + password returns a token and the user role', async () => {
    const res = await login({ email: ADMIN_EMAIL, password: 'admin123' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.role).toBe('school_admin');
  });

  test('wrong password is rejected with 401', async () => {
    const res = await login({ email: ADMIN_EMAIL, password: 'nope-wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });

  test('unknown account is rejected with 401', async () => {
    const res = await login({ email: 'ghost@login.test', password: 'whatever' });
    expect(res.status).toBe(401);
  });

  test('missing password is rejected with 400', async () => {
    const res = await login({ email: ADMIN_EMAIL });
    expect(res.status).toBe(400);
  });

  test('username field is accepted as an alias for the identifier', async () => {
    const res = await login({ username: DRIVER_EMAIL, password: 'driver123' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('driver');
  });
});

describe('Login — by phone number (various formats)', () => {
  test('E.164 format (+254...) logs in', async () => {
    const res = await login({ email: PARENT_PHONE, password: 'parent123' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(PARENT_EMAIL);
  });

  test('local format with leading 0 (0799...) is normalized and logs in', async () => {
    const res = await login({ email: '0799000004', password: 'parent123' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(PARENT_EMAIL);
  });

  test('bare 9-digit national number is normalized and logs in', async () => {
    const res = await login({ email: '799000004', password: 'parent123' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(PARENT_EMAIL);
  });

  test('phone login with wrong password still fails', async () => {
    const res = await login({ email: PARENT_PHONE, password: 'bad' });
    expect(res.status).toBe(401);
  });
});

describe('Login — deactivated account', () => {
  test('deactivated user with correct password is rejected with 403', async () => {
    const res = await login({ email: INACTIVE_EMAIL, password: 'parent123' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/deactivated/i);
  });
});

describe('Role gating — backend authorize() enforcement', () => {
  let adminToken, driverToken, parentToken;

  beforeAll(async () => {
    adminToken = await tokenFor(ADMIN_EMAIL, 'admin123');
    driverToken = await tokenFor(DRIVER_EMAIL, 'driver123');
    parentToken = await tokenFor(PARENT_EMAIL, 'parent123');
  });

  test('admin-only endpoint (/api/parents): admin allowed, driver & parent forbidden', async () => {
    const asAdmin = await request(app).get('/api/parents').auth(adminToken, { type: 'bearer' });
    const asDriver = await request(app).get('/api/parents').auth(driverToken, { type: 'bearer' });
    const asParent = await request(app).get('/api/parents').auth(parentToken, { type: 'bearer' });
    expect(asAdmin.status).toBe(200);
    expect(asDriver.status).toBe(403);
    expect(asParent.status).toBe(403);
  });

  test('driver endpoint (/api/driver/my-routes): driver allowed, parent forbidden', async () => {
    const asDriver = await request(app).get('/api/driver/my-routes').auth(driverToken, { type: 'bearer' });
    const asParent = await request(app).get('/api/driver/my-routes').auth(parentToken, { type: 'bearer' });
    expect(asDriver.status).toBe(200);
    expect(asParent.status).toBe(403);
  });

  test('parent endpoint (/api/location/my-bus): parent allowed, driver forbidden', async () => {
    const asParent = await request(app).get('/api/location/my-bus').auth(parentToken, { type: 'bearer' });
    const asDriver = await request(app).get('/api/location/my-bus').auth(driverToken, { type: 'bearer' });
    expect(asParent.status).toBe(200);
    expect(asDriver.status).toBe(403);
  });

  test('no token is rejected with 401', async () => {
    const res = await request(app).get('/api/parents');
    expect(res.status).toBe(401);
  });
});

describe('Role gating — per-app login gate (mirrors mobile AuthContext)', () => {
  // These arrays mirror the gates in:
  //   carribu_parent_app/src/contexts/AuthContext.js  -> ['parent','admin']
  //   carribu_driver_app/src/contexts/AuthContext.js  -> ['driver','coordinator','admin']
  const parentAppAllows = (role) => ['parent', 'admin'].includes(role);
  const driverAppAllows = (role) => ['driver', 'coordinator', 'admin'].includes(role);

  test('parent app accepts parents and rejects drivers/coordinators', () => {
    expect(parentAppAllows('parent')).toBe(true);
    expect(parentAppAllows('driver')).toBe(false);
    expect(parentAppAllows('coordinator')).toBe(false);
  });

  test('driver app accepts drivers and coordinators and rejects parents', () => {
    expect(driverAppAllows('driver')).toBe(true);
    expect(driverAppAllows('coordinator')).toBe(true);
    expect(driverAppAllows('parent')).toBe(false);
  });
});
