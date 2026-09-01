// Adds an optional time-of-day for a trip (e.g. 07:30). Nullable so existing
// scheduled trips remain valid.
module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(
      'ALTER TABLE trips ADD COLUMN IF NOT EXISTS scheduled_time TIME;'
    );
  },

  async down({ context: queryInterface }) {
    await queryInterface.sequelize.query(
      'ALTER TABLE trips DROP COLUMN IF EXISTS scheduled_time;'
    );
  },
};
