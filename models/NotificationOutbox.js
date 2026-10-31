const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = sequelize.define('NotificationOutbox', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  eventKey: { type: DataTypes.STRING(200), allowNull: false, unique: true, field: 'event_key' },
  schoolId: { type: DataTypes.INTEGER, allowNull: false, field: 'school_id' },
  tripId: { type: DataTypes.INTEGER, allowNull: false, field: 'trip_id' },
  receiverId: { type: DataTypes.INTEGER, allowNull: false, field: 'receiver_id' },
  messageId: { type: DataTypes.INTEGER, field: 'message_id' },
  event: { type: DataTypes.STRING(80), allowNull: false },
  payload: { type: DataTypes.JSONB, allowNull: false },
  status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
  attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  nextAttemptAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'next_attempt_at' },
  lockedUntil: { type: DataTypes.DATE, field: 'locked_until' },
  lastError: { type: DataTypes.STRING(200), field: 'last_error' },
  providerResults: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'provider_results' },
}, { tableName: 'notification_outbox', indexes: [{ fields: ['status', 'next_attempt_at'] }] });
