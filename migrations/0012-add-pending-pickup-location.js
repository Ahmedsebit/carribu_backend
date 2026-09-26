module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS pending_pickup_address TEXT,
      ADD COLUMN IF NOT EXISTS pending_pickup_lat DECIMAL(10,7),
      ADD COLUMN IF NOT EXISTS pending_pickup_lng DECIMAL(10,7),
      ADD COLUMN IF NOT EXISTS pending_pickup_requested_at TIMESTAMP WITH TIME ZONE;
    `);
  },

  async down({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS pending_pickup_requested_at,
      DROP COLUMN IF EXISTS pending_pickup_lng,
      DROP COLUMN IF EXISTS pending_pickup_lat,
      DROP COLUMN IF EXISTS pending_pickup_address;
    `);
  },
};
