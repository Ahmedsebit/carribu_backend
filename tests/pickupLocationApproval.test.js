const request = require('supertest');
const app = require('./testApp');
const { setupTestDB, teardownTestDB, getTestData } = require('./setup');
const { User } = require('../models');

let adminToken;
let parentToken;

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

describe('Parent pickup location approval', () => {
  test('parent location edits remain pending until approved by the school', async () => {
    const { parent } = getTestData();
    const response = await request(app)
      .put('/api/auth/profile')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ pickupAddress: 'Lavington, Nairobi', pickupLat: -1.2833, pickupLng: 36.7667 });

    expect(response.status).toBe(200);
    expect(response.body.message).toMatch(/school approval/i);
    expect(response.body.user.pickupAddress).toBe('Westlands, Nairobi');
    expect(response.body.user.pendingPickupAddress).toBe('Lavington, Nairobi');

    let storedParent = await User.findByPk(parent.id);
    expect(storedParent.pickupAddress).toBe('Westlands, Nairobi');
    expect(storedParent.pendingPickupRequestedAt).not.toBeNull();

    const approval = await request(app)
      .put(`/api/parents/${parent.id}/pickup-location/approve`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(approval.status).toBe(200);
    storedParent = await User.findByPk(parent.id);
    expect(storedParent.pickupAddress).toBe('Lavington, Nairobi');
    expect(Number(storedParent.pickupLat)).toBeCloseTo(-1.2833);
    expect(storedParent.pendingPickupAddress).toBeNull();
    expect(storedParent.pendingPickupRequestedAt).toBeNull();
  });

  test('school can reject a pending location without changing the approved location', async () => {
    const { parent } = getTestData();
    await request(app)
      .put('/api/auth/profile')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ pickupAddress: 'Karen, Nairobi', pickupLat: -1.3192, pickupLng: 36.7073 });

    const rejection = await request(app)
      .put(`/api/parents/${parent.id}/pickup-location/reject`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(rejection.status).toBe(200);
    const storedParent = await User.findByPk(parent.id);
    expect(storedParent.pickupAddress).toBe('Lavington, Nairobi');
    expect(storedParent.pendingPickupAddress).toBeNull();
  });
});
