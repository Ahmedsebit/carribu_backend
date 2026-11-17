module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      CREATE TABLE student_imports (
        id UUID PRIMARY KEY,
        school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        uploader_name VARCHAR(201) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        content_type VARCHAR(100) NOT NULL,
        file_data BYTEA NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'previewed',
        rows JSONB NOT NULL,
        counts JSONB NOT NULL,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT student_import_status CHECK (status IN ('previewed', 'completed'))
      );
      CREATE INDEX student_imports_school_created ON student_imports (school_id, created_at DESC);
    `);
  },
  async down({ context: queryInterface }) {
    await queryInterface.dropTable('student_imports');
  },
};
