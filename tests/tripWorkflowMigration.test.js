const { setupTestDB } = require('./setup');
const { sequelize } = require('../models');
const migration = require('../migrations/0016-trip-workflow-and-notification-outbox');
const context = { context: sequelize.getQueryInterface() };
let data;

beforeAll(async () => {
  if (!/^carribu_workflow_[a-z0-9_]+$/.test(process.env.DB_NAME || '') || process.env.DB_HOST !== '127.0.0.1') {
    throw new Error('Migration tests require an isolated local carribu_workflow_* database.');
  }
  data = await setupTestDB();
});
beforeEach(async () => migration.down(context));
afterEach(async () => {
  await sequelize.query('DELETE FROM trips');
  await migration.up(context);
});
afterAll(async () => sequelize.close());

test('upgrading an old schema and reversing/reapplying the migration preserves unrelated tables', async () => {
  await migration.up(context);
  expect((await context.context.describeTable('trips')).plan.type).toBe('JSONB');
  expect((await context.context.describeTable('trip_logs')).phase).toBeDefined();
  expect((await context.context.describeTable('notification_outbox')).provider_results.type).toBe('JSONB');
  const [indexes] = await sequelize.query("SELECT indexname FROM pg_indexes WHERE tablename IN ('trips', 'trip_logs')");
  expect(indexes.map(index => index.indexname)).toEqual(expect.arrayContaining([
    'trips_one_active_driver', 'trips_one_active_vehicle', 'trip_logs_action_phase', 'trip_logs_idempotency',
  ]));
  await migration.down(context);
  expect((await context.context.describeTable('trips')).plan).toBeUndefined();
  const [schools] = await sequelize.query('SELECT id FROM schools WHERE id = :id', { replacements: { id: data.school.id } });
  expect(schools).toHaveLength(1);
  await migration.up(context);
  await migration.up(context);
});

test.each(['driver', 'vehicle'])('an upgrade refuses an overlapping active %s and rolls back all schema changes', async resource => {
  const driverId = resource === 'driver' ? data.driver.id : null;
  const vehicleId = resource === 'vehicle' ? data.vehicle.id : null;
  await sequelize.query(`
    INSERT INTO trips (route_id, driver_id, vehicle_id, type, scheduled_date, status, created_at, updated_at)
    VALUES (:routeId, :driverId, :vehicleId, 'morning_pickup', '2026-10-30', 'in_progress', NOW(), NOW()),
           (:routeId, :driverId, :vehicleId, 'afternoon_dropoff', '2026-10-30', 'in_progress', NOW(), NOW())
  `, { replacements: { routeId: data.route.id, driverId, vehicleId } });
  await expect(migration.up(context)).rejects.toThrow('Resolve overlapping active trips');
  expect((await context.context.describeTable('trips')).plan).toBeUndefined();
  const [trips] = await sequelize.query("SELECT id FROM trips WHERE status = 'in_progress'");
  expect(trips).toHaveLength(2);
});
