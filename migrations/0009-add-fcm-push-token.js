module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS fcm_push_token VARCHAR(2048);
    `);
  },

  async down({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS fcm_push_token;
    `);
  },
};
