const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Trip = sequelize.define('Trip', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  routeId: { type: DataTypes.INTEGER, allowNull: false, field: 'route_id' },
  driverId: { type: DataTypes.INTEGER, field: 'driver_id' },
  vehicleId: { type: DataTypes.INTEGER, field: 'vehicle_id' },
  status: { type: DataTypes.ENUM('scheduled','in_progress','completed','cancelled'), defaultValue: 'scheduled' },
  type: { type: DataTypes.ENUM('morning_pickup','afternoon_dropoff'), allowNull: false },
  scheduledDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'scheduled_date' },
  scheduledTime: { type: DataTypes.TIME, allowNull: true, field: 'scheduled_time' },
  reminderSentAt: { type: DataTypes.DATE, allowNull: true, field: 'reminder_sent_at' },
  startedAt: { type: DataTypes.DATE, field: 'started_at' },
  endedAt: { type: DataTypes.DATE, field: 'ended_at' },
  notes: { type: DataTypes.TEXT },
}, { tableName: 'trips' });
module.exports = Trip;
