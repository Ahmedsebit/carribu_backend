// Tracks when the driver was sent the "trip starting soon" reminder so it is
// only delivered once per trip. Nullable: null means no reminder sent yet.
module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(
      'ALTER TABLE trips ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMP WITH TIME ZONE;'
    );
  },

  async down({ context: queryInterface }) {
    await queryInterface.sequelize.query(
      'ALTER TABLE trips DROP COLUMN IF EXISTS reminder_sent_at;'
    );
  },
};
