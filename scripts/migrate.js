#!/usr/bin/env node
require('dotenv').config();
const { sequelize } = require('../models');
const { migrator, runMigrations } = require('../config/migrator');

async function main() {
  const cmd = process.argv[2] || 'up';
  await sequelize.authenticate();

  switch (cmd) {
    case 'up':
      await runMigrations();
      break;
    case 'down':
      await migrator.down();
      console.log('✅ Reverted last migration.');
      break;
    case 'pending': {
      const pending = await migrator.pending();
      console.log(pending.length ? pending.map((m) => m.name).join('\n') : '(none)');
      break;
    }
    case 'status':
    case 'executed': {
      const executed = await migrator.executed();
      const pending = await migrator.pending();
      console.log('Executed:');
      console.log(executed.length ? executed.map((m) => '  ✓ ' + m.name).join('\n') : '  (none)');
      console.log('Pending:');
      console.log(pending.length ? pending.map((m) => '  • ' + m.name).join('\n') : '  (none)');
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}. Use up | down | pending | status`);
      process.exit(1);
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error('❌ Migration command failed:', err);
  process.exit(1);
});
