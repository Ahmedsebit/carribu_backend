const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const Subscription = sequelize.define('Subscription', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  schoolId: { type: DataTypes.INTEGER, allowNull: false, unique: true, field: 'school_id', references: { model: 'schools', key: 'id' } },
  plan: { type: DataTypes.ENUM('free', 'basic', 'premium', 'enterprise'), defaultValue: 'free' },
  status: { type: DataTypes.ENUM('active', 'expired', 'cancelled', 'trial'), defaultValue: 'trial' },
  maxStudents: { type: DataTypes.INTEGER, defaultValue: 50, field: 'max_students' },
  maxVehicles: { type: DataTypes.INTEGER, defaultValue: 5, field: 'max_vehicles' },
  startDate: { type: DataTypes.DATEONLY, field: 'start_date' },
  endDate: { type: DataTypes.DATEONLY, field: 'end_date' },
  amount: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
  currency: { type: DataTypes.STRING(3), defaultValue: 'KES' },
}, { tableName: 'subscriptions' });
module.exports = Subscription;
