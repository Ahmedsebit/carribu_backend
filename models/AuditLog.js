const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const AuditLog = sequelize.define('AuditLog', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  userId: { type: DataTypes.INTEGER, field: 'user_id' },
  schoolId: { type: DataTypes.INTEGER, field: 'school_id' },
  action: { type: DataTypes.STRING(100), allowNull: false },
  resource: { type: DataTypes.STRING(100) },
  resourceId: { type: DataTypes.INTEGER, field: 'resource_id' },
  details: { type: DataTypes.TEXT },
  ipAddress: { type: DataTypes.STRING(45), field: 'ip_address' },
}, { tableName: 'audit_logs', updatedAt: false });
module.exports = AuditLog;
