const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const RouteStudent = sequelize.define('RouteStudent', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  routeId: { type: DataTypes.INTEGER, allowNull: false, field: 'route_id' },
  studentId: { type: DataTypes.INTEGER, allowNull: false, field: 'student_id' },
  stopOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'stop_order' },
}, { tableName: 'route_students' });
module.exports = RouteStudent;
