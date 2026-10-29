module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      ALTER TABLE bus_locations
      ADD COLUMN IF NOT EXISTS source VARCHAR(16) NOT NULL DEFAULT 'phone';

      UPDATE bus_locations SET source = 'traccar'
      WHERE tracker_position_id IS NOT NULL AND source = 'phone';
    `);
  },

  async down({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      ALTER TABLE bus_locations DROP COLUMN IF EXISTS source;
    `);
  },
};
