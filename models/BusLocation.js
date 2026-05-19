const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');
const BusLocation = sequelize.define('BusLocation', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  tripId: { type: DataTypes.INTEGER, allowNull: false, field: 'trip_id' },
  vehicleId: { type: DataTypes.INTEGER, allowNull: false, field: 'vehicle_id' },
  driverId: { type: DataTypes.INTEGER, allowNull: false, field: 'driver_id' },
  lat: { type: DataTypes.DECIMAL(10,7), allowNull: false },
  lng: { type: DataTypes.DECIMAL(10,7), allowNull: false },
  speed: { type: DataTypes.DECIMAL(5,2) },
  heading: { type: DataTypes.DECIMAL(5,2) },
  recordedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'recorded_at' },
}, { tableName: 'bus_locations' });
module.exports = BusLocation;
