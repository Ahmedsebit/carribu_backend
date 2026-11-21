const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = sequelize.define('AbsenceRequest', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  schoolId: { type: DataTypes.INTEGER, allowNull: false, field: 'school_id' },
  studentId: { type: DataTypes.INTEGER, allowNull: false, field: 'student_id' },
  parentId: { type: DataTypes.INTEGER, allowNull: false, field: 'parent_id' },
  date: { type: DataTypes.DATEONLY, allowNull: false },
  reason: { type: DataTypes.TEXT },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
  reviewedById: { type: DataTypes.INTEGER, field: 'reviewed_by_id' },
  reviewedAt: { type: DataTypes.DATE, field: 'reviewed_at' },
  reviewNotes: { type: DataTypes.TEXT, field: 'review_notes' },
  confirmedTripIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: 'confirmed_trip_ids' },
}, { tableName: 'absence_requests', underscored: true });
