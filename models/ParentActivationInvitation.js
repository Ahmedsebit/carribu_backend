const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = sequelize.define('ParentActivationInvitation', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  parentId: { type: DataTypes.INTEGER, allowNull: false, field: 'parent_id' },
  schoolId: { type: DataTypes.INTEGER, allowNull: false, field: 'school_id' },
  issuedById: { type: DataTypes.INTEGER, field: 'issued_by_id' },
  codeHash: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: 'code_hash' },
  expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
  consumedAt: { type: DataTypes.DATE, field: 'consumed_at' },
}, {
  tableName: 'parent_activation_invitations',
  defaultScope: { attributes: { exclude: ['codeHash'] } },
});
