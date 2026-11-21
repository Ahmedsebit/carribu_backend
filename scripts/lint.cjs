const path = require('node:path');
const { spawnSync } = require('node:child_process');
const manifest = require('../package.json');
const name = manifest.devDependencies['eslint-quality'] ? 'eslint-quality' : 'eslint';
const directory = path.dirname(require.resolve(`${name}/package.json`));
const result = spawnSync(
  process.execPath,
  [
    path.join(directory, 'bin', 'eslint.js'),
    '--max-warnings=0',
    '--no-warn-ignored',
    '--',
    ...process.argv.slice(2),
  ],
  { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' },
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
