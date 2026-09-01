module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      CREATE TABLE IF NOT EXISTS parent_schools (
        id SERIAL PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
        school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE ON UPDATE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      );
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS parent_schools_parent_school_unique
      ON parent_schools (parent_id, school_id);
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS parent_schools_school_parent
      ON parent_schools (school_id, parent_id);
    `);
    await queryInterface.sequelize.query(`
      INSERT INTO parent_schools (parent_id, school_id, created_at, updated_at)
      SELECT id, school_id, NOW(), NOW()
      FROM users
      WHERE role = 'parent' AND school_id IS NOT NULL
      ON CONFLICT (parent_id, school_id) DO NOTHING;
    `);
  },

  async down({ context: queryInterface }) {
    await queryInterface.sequelize.query('DROP TABLE IF EXISTS parent_schools;');
  },
};
