const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function run(file, args = []) {
  const result = spawnSync(process.execPath, [file, ...args], { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}

run(path.join(__dirname, 'check-staged.cjs'));
const directory = path.dirname(require.resolve('lint-staged/package.json'));
run(path.join(directory, 'bin', 'lint-staged.js'), ['--concurrent', 'false']);
run(path.join(__dirname, 'check-staged.cjs'), ['--check-whitespace']);
