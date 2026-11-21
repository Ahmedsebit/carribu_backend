module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(`
      ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE parent_activation_invitations (
        id SERIAL PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
        issued_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        code_hash VARCHAR(64) NOT NULL UNIQUE,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX parent_activation_invitations_parent ON parent_activation_invitations (parent_id);
      `, { transaction });
    });
  },
  async down({ context: queryInterface }) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.dropTable('parent_activation_invitations', { transaction });
      await queryInterface.removeColumn('users', 'auth_version', { transaction });
    });
  },
};
