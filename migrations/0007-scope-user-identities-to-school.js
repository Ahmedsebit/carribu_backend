module.exports = {
  async up({ context: queryInterface }) {
    await queryInterface.sequelize.query(`
      DO $$
      DECLARE unique_constraint record;
      BEGIN
        FOR unique_constraint IN
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'users'::regclass
            AND contype = 'u'
            AND pg_get_constraintdef(oid) = 'UNIQUE (email)'
        LOOP
          EXECUTE format(
            'ALTER TABLE users DROP CONSTRAINT %I',
            unique_constraint.conname
          );
        END LOOP;
      END $$;
    `);
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS users_phone_unique;');
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_school_email_unique
      ON users (school_id, email)
      WHERE school_id IS NOT NULL;
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_global_email_unique
      ON users (email)
      WHERE school_id IS NULL;
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_school_phone_unique
      ON users (school_id, phone)
      WHERE school_id IS NOT NULL AND phone IS NOT NULL AND btrim(phone) <> '';
    `);
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_global_phone_unique
      ON users (phone)
      WHERE school_id IS NULL AND phone IS NOT NULL AND btrim(phone) <> '';
    `);
  },

  async down({ context: queryInterface }) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS users_global_phone_unique;');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS users_school_phone_unique;');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS users_global_email_unique;');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS users_school_email_unique;');
    await queryInterface.sequelize.query('CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL AND btrim(phone) <> \'\';');
    await queryInterface.sequelize.query('CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);');
  },
};
