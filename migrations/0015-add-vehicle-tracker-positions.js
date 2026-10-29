module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS vehicle_tracker_positions (
        vehicle_id INTEGER PRIMARY KEY REFERENCES vehicles(id) ON DELETE CASCADE,
        tracker_unique_id VARCHAR(128) NOT NULL,
        tracker_position_id BIGINT,
        lat DECIMAL(10,7) NOT NULL,
        lng DECIMAL(10,7) NOT NULL,
        speed DECIMAL(5,2),
        heading DECIMAL(5,2),
        recorded_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
  },

  async down({ context: queryInterface }) {
    await queryInterface.dropTable('vehicle_tracker_positions');
  },
};
