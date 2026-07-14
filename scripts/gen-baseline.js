// One-time (re-runnable) generator that captures the current models' schema as
// a frozen SQL baseline. It syncs the models into whatever database DB_NAME
// points at (use a throwaway DB!) and writes the emitted DDL to
// migrations/sql/0001-baseline.sql.
//
// Usage (PowerShell):
//   $env:DB_NAME="carribu_baseline_tmp"; node scripts/gen-baseline.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { sequelize } = require('../models');

(async () => {
  const stmts = [];
  await sequelize.sync({ force: true, logging: (sql) => stmts.push(sql) });

  const ddl = stmts
    .map((s) => s.replace(/^Executing \(default\):\s*/, '').trim())
    .filter((s) => /^(CREATE|ALTER|COMMENT|DO)\b/i.test(s))
    .filter((s) => !/^DROP\b/i.test(s))
    .map((s) => (s.endsWith(';') ? s : s + ';'));

  // Enum types are referenced inline by CREATE TABLE but Sequelize emits their
  // CREATE TYPE inside later compound ALTER statements. Extract every enum
  // definition and emit idempotent CREATE TYPE blocks up front so the baseline
  // applies cleanly on an empty database regardless of statement order.
  const enumRe = /CREATE TYPE ("public"\."[^"]+") AS ENUM\(([^)]*)\)/g;
  const seen = new Set();
  const preludeLines = [];
  const joined = ddl.join('\n');
  let m;
  while ((m = enumRe.exec(joined))) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    const vals = m[2].replace(/''/g, "'"); // undouble quotes captured from DO literal
    preludeLines.push(`DO $$ BEGIN CREATE TYPE ${name} AS ENUM(${vals}); EXCEPTION WHEN duplicate_object THEN null; END $$;`);
  }
  const prelude = preludeLines.length
    ? '-- Enum types (idempotent, must precede CREATE TABLE references).\n' + preludeLines.join('\n') + '\n\n'
    : '';

  const header = '-- Frozen schema baseline generated from Sequelize models.\n'
    + '-- Do NOT edit by hand. Regenerate with: node scripts/gen-baseline.js\n'
    + '-- Represents the schema at the point migrations were introduced.\n\n';

  const outPath = path.join(__dirname, '..', 'migrations', 'sql', '0001-baseline.sql');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, header + prelude + ddl.join('\n') + '\n');

  console.log(`Wrote ${ddl.length} statements (+${preludeLines.length} enum prelude) to ${outPath}`);
  await sequelize.close();
})().catch((e) => { console.error(e); process.exit(1); });
