const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const TrackerEvent = sequelize.define('TrackerEvent', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  vehicleId: { type: DataTypes.INTEGER, allowNull: false, field: 'vehicle_id' },
  tripId: { type: DataTypes.INTEGER, allowNull: true, field: 'trip_id' },
  trackerEventId: { type: DataTypes.BIGINT, allowNull: true, unique: true, field: 'tracker_event_id' },
  eventType: { type: DataTypes.STRING(100), allowNull: false, field: 'event_type' },
  eventTime: { type: DataTypes.DATE, allowNull: false, field: 'event_time' },
  attributes: { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
}, { tableName: 'tracker_events' });

module.exports = TrackerEvent;
