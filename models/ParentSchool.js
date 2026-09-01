const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ParentSchool = sequelize.define('ParentSchool', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  parentId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'parent_id',
    references: { model: 'users', key: 'id' },
  },
  schoolId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    field: 'school_id',
    references: { model: 'schools', key: 'id' },
  },
}, {
  tableName: 'parent_schools',
  indexes: [{
    name: 'parent_schools_parent_school_unique',
    unique: true,
    fields: ['parent_id', 'school_id'],
  }],
});

module.exports = ParentSchool;
