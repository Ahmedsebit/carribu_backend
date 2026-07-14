const { DataTypes } = require('sequelize');

// Adds an optional time-of-day for a trip (e.g. 07:30). Nullable so existing
// scheduled trips remain valid.
module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.addColumn('trips', 'scheduled_time', {
      type: DataTypes.TIME,
      allowNull: true,
    });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeColumn('trips', 'scheduled_time');
  },
};
