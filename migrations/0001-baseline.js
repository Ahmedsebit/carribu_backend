const fs = require('fs');
const path = require('path');

// Baseline migration: creates the full schema (enums, tables, foreign keys)
// as captured from the Sequelize models at the time migrations were introduced.
const BASELINE_SQL = path.join(__dirname, 'sql', '0001-baseline.sql');

module.exports = {
  async up({ context: queryInterface }) {
    const sql = fs.readFileSync(BASELINE_SQL, 'utf8');
    await queryInterface.sequelize.query(sql);
  },

  async down({ context: queryInterface }) {
    // Baseline is the root of schema history; undoing it drops everything.
    await queryInterface.sequelize.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  },
};
