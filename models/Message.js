const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/database');
const Message = sequelize.define('Message', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  schoolId: { type: DataTypes.INTEGER, allowNull: false, field: 'school_id' },
  senderId: { type: DataTypes.INTEGER, allowNull: true, field: 'sender_id' },
  receiverId: { type: DataTypes.INTEGER, allowNull: true, field: 'receiver_id' },
  tripId: { type: DataTypes.INTEGER, field: 'trip_id' },
  content: { type: DataTypes.TEXT, allowNull: false },
  clientMessageId: { type: DataTypes.STRING(100), field: 'client_message_id' },
  messageType: { type: DataTypes.ENUM('text','alert','absence','arrival','system'), defaultValue: 'text', field: 'message_type' },
  isRead: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'is_read' },
  senderDeletedAt: { type: DataTypes.DATE, allowNull: true, field: 'sender_deleted_at' },
  receiverDeletedAt: { type: DataTypes.DATE, allowNull: true, field: 'receiver_deleted_at' },
}, { tableName: 'messages', indexes: [{
  name: 'messages_sender_client_unique', unique: true, fields: ['sender_id', 'client_message_id'],
  where: { client_message_id: { [Op.ne]: null } },
}] });
module.exports = Message;
