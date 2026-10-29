const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = sequelize.define('VehicleTrackerPosition', {
  vehicleId: {
    type: DataTypes.INTEGER, primaryKey: true, allowNull: false, field: 'vehicle_id',
    references: { model: 'vehicles', key: 'id' }, onDelete: 'CASCADE',
  },
  trackerUniqueId: { type: DataTypes.STRING(128), allowNull: false, field: 'tracker_unique_id' },
  trackerPositionId: { type: DataTypes.BIGINT, allowNull: true, field: 'tracker_position_id' },
  lat: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
  lng: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
  speed: { type: DataTypes.DECIMAL(5, 2) },
  heading: { type: DataTypes.DECIMAL(5, 2) },
  recordedAt: { type: DataTypes.DATE, allowNull: false, field: 'recorded_at' },
}, { tableName: 'vehicle_tracker_positions' });
