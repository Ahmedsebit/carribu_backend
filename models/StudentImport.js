const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = sequelize.define('StudentImport', {
  id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
  schoolId: { type: DataTypes.INTEGER, allowNull: false },
  uploadedBy: { type: DataTypes.INTEGER, allowNull: true },
  uploaderName: { type: DataTypes.STRING(201), allowNull: false },
  filename: { type: DataTypes.STRING(255), allowNull: false },
  contentType: { type: DataTypes.STRING(100), allowNull: false },
  fileData: { type: DataTypes.BLOB, allowNull: false },
  status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'previewed' },
  rows: { type: DataTypes.JSONB, allowNull: false },
  counts: { type: DataTypes.JSONB, allowNull: false },
  completedAt: { type: DataTypes.DATE },
}, {
  tableName: 'student_imports',
  defaultScope: { attributes: { exclude: ['fileData'] } },
});
