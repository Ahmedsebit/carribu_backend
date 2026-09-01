const { DataTypes, Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const sequelize = require('../config/database');
const User = sequelize.define('User', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  schoolId: { type: DataTypes.INTEGER, allowNull: true, field: 'school_id', references: { model: 'schools', key: 'id' } },
  email: { type: DataTypes.STRING(150), allowNull: false, validate: { isEmail: true } },
  passwordHash: { type: DataTypes.STRING(255), allowNull: false, field: 'password_hash' },
  firstName: { type: DataTypes.STRING(100), allowNull: false, field: 'first_name' },
  lastName: { type: DataTypes.STRING(100), allowNull: false, field: 'last_name' },
  role: { type: DataTypes.ENUM('super_admin','school_admin','coordinator','driver','parent'), allowNull: false, defaultValue: 'parent' },
  phone: { type: DataTypes.STRING(20) },
  pickupAddress: { type: DataTypes.TEXT, field: 'pickup_address' },
  pickupLat: { type: DataTypes.DECIMAL(10,7), field: 'pickup_lat' },
  pickupLng: { type: DataTypes.DECIMAL(10,7), field: 'pickup_lng' },
  dropoffAddress: { type: DataTypes.TEXT, field: 'dropoff_address' },
  dropoffLat: { type: DataTypes.DECIMAL(10,7), field: 'dropoff_lat' },
  dropoffLng: { type: DataTypes.DECIMAL(10,7), field: 'dropoff_lng' },
  expoPushToken: { type: DataTypes.STRING(255), field: 'expo_push_token' },
  isActive: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'is_active' },
  mustSetPassword: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'must_set_password' },
}, {
  tableName: 'users',
  indexes: [
    {
      name: 'users_school_email_unique',
      unique: true,
      fields: ['school_id', 'email'],
      where: { school_id: { [Op.ne]: null } },
    },
    {
      name: 'users_global_email_unique',
      unique: true,
      fields: ['email'],
      where: { school_id: null },
    },
    {
      name: 'users_school_phone_unique',
      unique: true,
      fields: ['school_id', 'phone'],
      where: { school_id: { [Op.ne]: null }, phone: { [Op.ne]: '' } },
    },
    {
      name: 'users_global_phone_unique',
      unique: true,
      fields: ['phone'],
      where: { school_id: null, phone: { [Op.ne]: '' } },
    },
  ],
  hooks: {
    beforeCreate: async (user) => { if (user.passwordHash) user.passwordHash = await bcrypt.hash(user.passwordHash, 12); },
    beforeUpdate: async (user) => { if (user.changed('passwordHash')) user.passwordHash = await bcrypt.hash(user.passwordHash, 12); },
    afterCreate: async (user, options) => {
      if (user.role === 'parent' && user.schoolId) {
        const ParentSchool = require('./ParentSchool');
        await ParentSchool.findOrCreate({
          where: { parentId: user.id, schoolId: user.schoolId },
          transaction: options.transaction,
        });
      }
    },
  },
});
User.prototype.validPassword = async function(password) { return bcrypt.compare(password, this.passwordHash); };
User.prototype.toJSON = function() { const v = { ...this.get() }; delete v.passwordHash; return v; };
module.exports = User;
