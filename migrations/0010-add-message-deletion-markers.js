module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS sender_deleted_at TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS receiver_deleted_at TIMESTAMP WITH TIME ZONE;
    `);
  },

  async down({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      ALTER TABLE messages
      DROP COLUMN IF EXISTS sender_deleted_at,
      DROP COLUMN IF EXISTS receiver_deleted_at;
    `);
  },
};
