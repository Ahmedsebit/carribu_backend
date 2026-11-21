const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const omit = (process.env.npm_config_omit || '').split(/[,\s]+/);
const skip =
  process.env.HUSKY === '0' ||
  process.env.NODE_ENV === 'production' ||
  (process.env.CI && process.env.CI !== 'false') ||
  omit.includes('dev');

if (!skip && fs.existsSync(path.join(root, '.git'))) {
  process.chdir(root);
  import('husky')
    .then(({ default: install }) => {
      const error = install();
      if (error) throw new Error(error);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
