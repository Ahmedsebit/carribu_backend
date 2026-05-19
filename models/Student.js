const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Student = sequelize.define('Student', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  schoolId: { type: DataTypes.INTEGER, allowNull: false, field: 'school_id' },
  parentId: { type: DataTypes.INTEGER, field: 'parent_id' },
  firstName: { type: DataTypes.STRING(100), allowNull: false, field: 'first_name' },
  lastName: { type: DataTypes.STRING(100), allowNull: false, field: 'last_name' },
  grade: { type: DataTypes.STRING(20) },
  pickupAddress: { type: DataTypes.TEXT, field: 'pickup_address' },
  pickupLat: { type: DataTypes.DECIMAL(10,7), field: 'pickup_lat' },
  pickupLng: { type: DataTypes.DECIMAL(10,7), field: 'pickup_lng' },
  dropoffAddress: { type: DataTypes.TEXT, field: 'dropoff_address' },
  dropoffLat: { type: DataTypes.DECIMAL(10,7), field: 'dropoff_lat' },
  dropoffLng: { type: DataTypes.DECIMAL(10,7), field: 'dropoff_lng' },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'is_active' },
}, { tableName: 'students' });
module.exports = Student;
