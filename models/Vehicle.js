const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Vehicle = sequelize.define('Vehicle', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  schoolId: { type: DataTypes.INTEGER, allowNull: false, field: 'school_id', references: { model: 'schools', key: 'id' } },
  plateNumber: { type: DataTypes.STRING(20), allowNull: false, unique: true, field: 'plate_number' },
  make: { type: DataTypes.STRING(100) },
  model: { type: DataTypes.STRING(100) },
  year: { type: DataTypes.INTEGER },
  capacity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
  color: { type: DataTypes.STRING(50) },
  status: { type: DataTypes.ENUM('active','maintenance','retired'), defaultValue: 'active' },
  insuranceExpiry: { type: DataTypes.DATEONLY, field: 'insurance_expiry' },
  lastServiceDate: { type: DataTypes.DATEONLY, field: 'last_service_date' },
}, { tableName: 'vehicles' });
module.exports = Vehicle;
