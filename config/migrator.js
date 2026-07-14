const path = require('path');
const { Umzug, SequelizeStorage } = require('umzug');
const { sequelize } = require('../models');

// Umzug migrator. Migration files live in ../migrations and export { up, down }.
const migrator = new Umzug({
  migrations: {
    glob: ['*.js', { cwd: path.join(__dirname, '..', 'migrations') }],
    resolve: ({ name, path: migPath, context }) => {
      const migration = require(migPath);
      return {
        name,
        up: async () => migration.up({ context }),
        down: async () => migration.down({ context }),
      };
    },
  },
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, modelName: 'SequelizeMeta' }),
  logger: console,
});

// Returns the set of application table names currently present.
async function existingTables() {
  const qi = sequelize.getQueryInterface();
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName));
}

// Run pending migrations. For legacy databases (created before migrations
// existed) the baseline is marked as already applied so it is not re-run.
async function runMigrations() {
  // executed() transparently creates the migration bookkeeping table if absent.
  const executed = await migrator.executed();

  if (executed.length === 0) {
    const tables = await existingTables();
    if (tables.includes('users')) {
      // Existing schema predates migrations: record baseline without executing.
      console.log('ℹ️  Existing schema detected without migration history; baselining.');
      await migrator.storage.logMigration({ name: '0001-baseline.js' });
    }
  }

  const pending = await migrator.pending();
  if (pending.length === 0) {
    console.log('✅ Database schema up to date (no pending migrations).');
    return [];
  }
  console.log(`▶️  Running ${pending.length} pending migration(s): ${pending.map((m) => m.name).join(', ')}`);
  const applied = await migrator.up();
  console.log(`✅ Applied ${applied.length} migration(s).`);
  return applied;
}

module.exports = { migrator, runMigrations };
