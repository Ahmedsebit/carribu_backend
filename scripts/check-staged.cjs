const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const git = (args) =>
  execFileSync('git', ['--no-pager', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const signatures = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /\b(?:sk_(?:live|proj|svcacct)_|rk_live_)[A-Za-z0-9_-]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /"type"\s*:\s*"service_account"/,
];

try {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(Boolean);
  for (const file of files) {
    const parts = file.split('/');
    const name = parts.at(-1);
    const forbidden =
      parts.some((part) => /^\.env(?:\.|$)/i.test(part) && part !== '.env.example') ||
      /(?:service[-_]?account|adminsdk|credentials).*\.json$/i.test(name) ||
      /\.(?:pem|key|p12|pfx|p8|jks|keystore|mobileprovision)$/i.test(name) ||
      parts.some((part) =>
        ['node_modules', '.expo', '.copilot', 'build', 'dist', 'coverage', 'uploads'].includes(
          part,
        ),
      ) ||
      file.startsWith('.husky/_/');
    if (forbidden)
      throw new Error(`Refusing local credentials or generated artifacts: ${JSON.stringify(file)}`);
  }
  const staged = new Set(files);
  for (const record of git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    if (record.startsWith('120000 ') && staged.has(record.slice(record.indexOf('\t') + 1))) {
      throw new Error(
        'Staged symbolic links must not be followed by formatters. Stage ordinary source files instead.',
      );
    }
  }
  for (const file of files) {
    const content = git(['show', '--no-textconv', `:${file}`]);
    if (/^(?:<{7}|={7}|>{7})(?:[ \t].*)?\r?$/m.test(content))
      throw new Error(`Merge conflict marker in ${JSON.stringify(file)}`);
    if (signatures.some((pattern) => pattern.test(content)))
      throw new Error(
        `Credential pattern in ${JSON.stringify(file)} (value suppressed). Remove it and rotate it if real.`,
      );
  }
  if (process.argv.includes('--check-whitespace')) {
    try {
      git(['diff', '--cached', '--check']);
    } catch {
      throw new Error('Staged whitespace errors remain. Inspect git diff --cached --check.');
    }
  }
} catch (error) {
  console.error(
    error instanceof Error && !error.stdout ? error.message : 'Unable to check the Git index.',
  );
  process.exitCode = 1;
}
