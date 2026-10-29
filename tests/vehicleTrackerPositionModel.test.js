jest.mock('../config/database', () => {
  const { Sequelize } = require('sequelize');
  return new Sequelize({
    dialect: 'postgres', database: 'snapshot_model_test', logging: false,
    define: { timestamps: true, underscored: true },
  });
});

const { sequelize, Vehicle, VehicleTrackerPosition } = require('../models');
const migration = require('../migrations/0015-add-vehicle-tracker-positions');

afterAll(() => sequelize.close());

test('stores exactly one snapshot per vehicle without a generated ID or trip association', () => {
  expect(VehicleTrackerPosition.getTableName()).toBe('vehicle_tracker_positions');
  expect(VehicleTrackerPosition.primaryKeyAttributes).toEqual(['vehicleId']);
  expect(VehicleTrackerPosition.rawAttributes.vehicleId.field).toBe('vehicle_id');
  expect(VehicleTrackerPosition.rawAttributes.id).toBeUndefined();
  expect(VehicleTrackerPosition.rawAttributes.tripId).toBeUndefined();
  expect(VehicleTrackerPosition.rawAttributes.recordedAt.allowNull).toBe(false);
  expect(VehicleTrackerPosition.rawAttributes.recordedAt.defaultValue).toBeUndefined();
  expect(VehicleTrackerPosition.rawAttributes.createdAt.field).toBe('created_at');
});

test('cascades snapshot deletion with its vehicle and uses the existing camelCase model field', () => {
  expect(Vehicle.associations.trackerPosition.foreignKey).toBe('vehicleId');
  expect(VehicleTrackerPosition.associations.vehicle.foreignKey).toBe('vehicleId');
  expect(VehicleTrackerPosition.rawAttributes.vehicleId.onDelete).toBe('CASCADE');
  expect(VehicleTrackerPosition.rawAttributes.vehicle_id).toBeUndefined();
});

test('migration uses a matching independent table with no trip-history backfill', async () => {
  const query = jest.fn();
  await migration.up({ context: { sequelize: { query } } });
  const sql = query.mock.calls[0][0];
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS vehicle_tracker_positions');
  expect(sql).toContain('vehicle_id INTEGER PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE');
  for (const field of ['tracker_unique_id', 'tracker_position_id', 'lat', 'lng', 'speed', 'heading', 'recorded_at', 'created_at', 'updated_at']) {
    expect(sql).toMatch(new RegExp(`\\b${field}\\b`));
  }
  expect(sql).not.toContain('bus_locations');
  const dropTable = jest.fn();
  await migration.down({ context: { dropTable } });
  expect(dropTable).toHaveBeenCalledWith('vehicle_tracker_positions');
});
