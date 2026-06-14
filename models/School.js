const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const School = sequelize.define('School', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(200), allowNull: false },
  address: { type: DataTypes.TEXT },
  city: { type: DataTypes.STRING(100) },
  phone: { type: DataTypes.STRING(20) },
  email: { type: DataTypes.STRING(150), validate: { isEmail: true } },
  logoUrl: { type: DataTypes.STRING(500), field: 'logo_url' },
  managedBy: { type: DataTypes.INTEGER, allowNull: true, field: 'managed_by', references: { model: 'users', key: 'id' } },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'is_active' },
}, { tableName: 'schools' });
module.exports = School;
