module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(`
        CREATE TABLE absence_requests (
          id SERIAL PRIMARY KEY,
          school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
          student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
          parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          reason TEXT,
          status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
          reviewed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          reviewed_at TIMESTAMPTZ,
          review_notes TEXT,
          confirmed_trip_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX absence_requests_school_date ON absence_requests (school_id, date, created_at DESC);
        CREATE UNIQUE INDEX absence_requests_open_student_date
          ON absence_requests (school_id, student_id, date) WHERE status <> 'rejected';
        ALTER TABLE trip_logs ADD COLUMN recorded_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
      `, { transaction });
    });
  },
  async down({ context: queryInterface }) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query('ALTER TABLE trip_logs DROP COLUMN recorded_by_id; DROP TABLE absence_requests;', { transaction });
    });
  },
};
