const { DataTypes } = require('sequelize');

// Tracks when the driver was sent the "trip starting soon" reminder so it is
// only delivered once per trip. Nullable: null means no reminder sent yet.
module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.addColumn('trips', 'reminder_sent_at', {
      type: DataTypes.DATE,
      allowNull: true,
    });
  },

  async down({ context: queryInterface }) {
    await queryInterface.removeColumn('trips', 'reminder_sent_at');
  },
};
