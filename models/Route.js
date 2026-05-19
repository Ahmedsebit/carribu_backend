const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Route = sequelize.define('Route', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  schoolId: { type: DataTypes.INTEGER, allowNull: false, field: 'school_id' },
  name: { type: DataTypes.STRING(200), allowNull: false },
  description: { type: DataTypes.TEXT },
  vehicleId: { type: DataTypes.INTEGER, field: 'vehicle_id' },
  driverId: { type: DataTypes.INTEGER, field: 'driver_id' },
  type: { type: DataTypes.ENUM('morning','afternoon','both'), defaultValue: 'both' },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'is_active' },
}, { tableName: 'routes' });
module.exports = Route;
