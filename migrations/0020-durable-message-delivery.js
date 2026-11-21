module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(`
        ALTER TABLE notification_outbox ALTER COLUMN trip_id DROP NOT NULL;
        ALTER TABLE messages ADD COLUMN client_message_id VARCHAR(100);
        CREATE UNIQUE INDEX messages_sender_client_unique
          ON messages (sender_id, client_message_id) WHERE client_message_id IS NOT NULL;
      `, { transaction });
    });
  },
  async down({ context: queryInterface }) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(`
        DELETE FROM notification_outbox WHERE trip_id IS NULL;
        ALTER TABLE notification_outbox ALTER COLUMN trip_id SET NOT NULL;
        DROP INDEX messages_sender_client_unique;
        ALTER TABLE messages DROP COLUMN client_message_id;
      `, { transaction });
    });
  },
};
