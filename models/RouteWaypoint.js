const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const RouteWaypoint = sequelize.define('RouteWaypoint', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  routeId: { type: DataTypes.INTEGER, allowNull: false, field: 'route_id', references: { model: 'routes', key: 'id' } },
  leg: { type: DataTypes.ENUM('outbound', 'return'), allowNull: false, defaultValue: 'outbound' },
  orderIndex: { type: DataTypes.INTEGER, allowNull: false, field: 'order_index' },
  lat: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
  lng: { type: DataTypes.DECIMAL(10, 7), allowNull: false },
  label: { type: DataTypes.STRING(200) },
  isStop: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'is_stop' },
}, { tableName: 'route_waypoints' });

module.exports = RouteWaypoint;
