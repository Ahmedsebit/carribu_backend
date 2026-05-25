const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const TripLog = sequelize.define('TripLog', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  tripId: { type: DataTypes.INTEGER, allowNull: false, field: 'trip_id' },
  studentId: { type: DataTypes.INTEGER, allowNull: false, field: 'student_id' },
  action: { type: DataTypes.ENUM('check_in','check_out','absent','arrived'), allowNull: false },
  timestamp: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  lat: { type: DataTypes.DECIMAL(10,7) },
  lng: { type: DataTypes.DECIMAL(10,7) },
  notes: { type: DataTypes.TEXT },
}, { tableName: 'trip_logs' });
module.exports = TripLog;
