module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      UPDATE users
      SET phone = NULL
      WHERE phone IS NOT NULL AND btrim(phone) = '';
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique
      ON users (phone)
      WHERE phone IS NOT NULL AND btrim(phone) <> '';
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS students_school_admission_normalized_unique
      ON students (school_id, upper(btrim(admission_number)))
      WHERE admission_number IS NOT NULL AND btrim(admission_number) <> '';
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS vehicles_plate_normalized_unique
      ON vehicles (upper(regexp_replace(btrim(plate_number), '\\s+', ' ', 'g')));
    `);
  },

  async down({ context: queryInterface }) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS vehicles_plate_normalized_unique;');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS students_school_admission_normalized_unique;');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS users_phone_unique;');
  },
};
