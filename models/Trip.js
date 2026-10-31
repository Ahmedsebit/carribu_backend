const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Trip = sequelize.define('Trip', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  routeId: { type: DataTypes.INTEGER, allowNull: false, field: 'route_id' },
  driverId: { type: DataTypes.INTEGER, field: 'driver_id' },
  vehicleId: { type: DataTypes.INTEGER, field: 'vehicle_id' },
  status: { type: DataTypes.ENUM('scheduled','delayed','in_progress','completed','cancelled','missed'), defaultValue: 'scheduled' },
  type: { type: DataTypes.ENUM('morning_pickup','afternoon_dropoff'), allowNull: false },
  scheduledDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'scheduled_date' },
  scheduledTime: { type: DataTypes.TIME, allowNull: true, field: 'scheduled_time' },
  reminderSentAt: { type: DataTypes.DATE, allowNull: true, field: 'reminder_sent_at' },
  startedAt: { type: DataTypes.DATE, field: 'started_at' },
  endedAt: { type: DataTypes.DATE, field: 'ended_at' },
  notes: { type: DataTypes.TEXT },
  plan: { type: DataTypes.JSONB, allowNull: true },
}, {
  tableName: 'trips',
  indexes: [
    { name: 'trips_one_active_driver', unique: true, fields: ['driver_id'], where: { status: 'in_progress' } },
    { name: 'trips_one_active_vehicle', unique: true, fields: ['vehicle_id'], where: { status: 'in_progress' } },
  ],
});
module.exports = Trip;
