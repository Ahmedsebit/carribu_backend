const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const AppVersion = sequelize.define('AppVersion', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  appName: { type: DataTypes.STRING(100), allowNull: false, field: 'app_name' },
  version: { type: DataTypes.STRING(20), allowNull: false },
  downloadUrl: { type: DataTypes.STRING(1000), allowNull: false, field: 'download_url' },
  releaseNotes: { type: DataTypes.TEXT, field: 'release_notes' },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'is_active' },
}, { tableName: 'app_versions' });

module.exports = AppVersion;
