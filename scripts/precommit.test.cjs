const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = require('../package.json');

function fixture(t, withGit = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'carribu-quality-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HUSKY: '',
    CI: '',
    NODE_ENV: 'development',
    npm_config_omit: '',
    GIT_CONFIG_GLOBAL: path.join(cwd, 'unused-global'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', ...options });
    return { ...result, output: `${result.stdout || ''}${result.stderr || ''}` };
  };
  const git = (...args) => {
    const result = run('git', ['--no-pager', ...args]);
    assert.equal(result.status, 0, result.output);
    return result.stdout;
  };
  const write = (file, text) => {
    const target = path.join(cwd, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  const files = [
    'package.json',
    'eslint.config.cjs',
    '.prettierignore',
    '.gitattributes',
    path.join('.husky', 'pre-commit'),
    ...['setup-hooks', 'lint', 'precommit', 'check-staged'].map((name) =>
      path.join('scripts', `${name}.cjs`),
    ),
  ];
  for (const file of files) write(file, fs.readFileSync(path.join(root, file)));
  const commit = () => run('git', ['commit', '-qm', 'Quality hook fixture']);
  if (withGit) {
    fs.symlinkSync(
      path.join(root, 'node_modules'),
      path.join(cwd, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    write('.gitignore', 'node_modules/\n.husky/_/\n.env\nbuild/\n');
    git('init', '-q');
    git('config', 'user.name', 'Quality Fixture');
    git('config', 'user.email', 'quality@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    git('add', '--', ...files, '.gitignore');
    assert.equal(
      run('git', ['commit', '-qm', 'Fixture baseline'], {
        env: { ...env, HUSKY: '0' },
      }).status,
      0,
    );
    const prepared = run(process.execPath, [path.join('scripts', 'setup-hooks.cjs')]);
    assert.equal(prepared.status, 0, prepared.output);
    assert.equal(git('config', '--get', 'core.hooksPath').trim(), '.husky/_');
  }
  return { cwd, env, run, git, write, commit };
}

test('real commit formats and restages filenames with spaces and Unicode', (t) => {
  const f = fixture(t);
  const file = `parent ${String.fromCharCode(233)}.cjs`;
  f.write(file, 'module.exports={ready:true}   \n');
  f.git('add', '--', file);
  const result = f.commit();
  assert.equal(result.status, 0, result.output);
  assert.equal(f.git('show', `HEAD:${file}`), 'module.exports = { ready: true };\n');
  assert.equal(f.git('status', '--porcelain'), '');
});

for (const [name, content, expected] of [
  ['undefined variable', 'module.exports = missing;\n', /no-undef/],
  ['parse failure', 'const = ;\n', /SyntaxError|Parsing error/],
  ['merge markers', '<'.repeat(7) + ' branch\nmodule.exports = 1;\n', /Merge conflict marker/],
  [
    'credential signature',
    `module.exports = '${'ghp_' + 'a'.repeat(36)}';\n`,
    /Credential pattern/,
  ],
]) {
  test(`real commit blocks ${name} without changing the index or worktree`, (t) => {
    const f = fixture(t);
    f.write('blocked.cjs', content);
    f.git('add', '--', 'blocked.cjs');
    const before = f.git('diff', '--cached');
    const head = f.git('rev-parse', 'HEAD');
    const result = f.commit();
    assert.notEqual(result.status, 0);
    assert.match(result.output, expected);
    assert.equal(f.git('rev-parse', 'HEAD'), head);
    assert.equal(f.git('diff', '--cached'), before);
    assert.equal(fs.readFileSync(path.join(f.cwd, 'blocked.cjs'), 'utf8'), content);
    assert.equal(f.git('stash', 'list'), '');
    if (name === 'credential signature')
      assert.ok(!result.output.includes('ghp_' + 'a'.repeat(36)));
  });
}

for (const file of ['.env', 'fcm-service-account.json', path.join('build', 'bundle.js')]) {
  test(`real commit rejects excluded path ${file}`, (t) => {
    const f = fixture(t);
    f.write(file, 'placeholder\n');
    f.git('add', '-f', '--', file);
    const result = f.commit();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Refusing local credentials or generated artifacts/);
  });
}

test('credential checks use the staged blob, not the worktree or text diff', (t) => {
  const f = fixture(t);
  const token = 'ghp_' + 'b'.repeat(36);
  f.write('opaque.bin', Buffer.from(`\0${token}`));
  f.git('add', '--', 'opaque.bin');
  f.write('opaque.bin', 'safe unstaged content');
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Credential pattern/);
  assert.ok(!result.output.includes(token));
});

test('staged symlinks are rejected before any formatter follows them', (t) => {
  const f = fixture(t);
  const hash = f.run('git', ['hash-object', '-w', '--stdin'], { input: '.env' });
  assert.equal(hash.status, 0, hash.output);
  f.git('update-index', '--add', '--cacheinfo', `120000,${hash.stdout.trim()},linked.cjs`);
  const result = f.commit();
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Staged symbolic links/);
});

for (const fail of [false, true]) {
  test(`partial staging ${fail ? 'rolls back on failure' : 'preserves unstaged edits on success'}`, (t) => {
    const f = fixture(t);
    const source = (first) =>
      `const first = ${first};\n` +
      '// Separate the staged and unstaged hunks.\n'.repeat(12) +
      'const second = 1;\nmodule.exports = { first, second };\n';
    f.write('partial.cjs', source(1));
    f.git('add', '--', 'partial.cjs');
    assert.equal(f.commit().status, 0);
    f.write('partial.cjs', source(fail ? 'missing' : 2).replace('const first =', 'const first='));
    f.git('add', '--', 'partial.cjs');
    const staged = f.git('diff', '--cached');
    const unstaged = fs
      .readFileSync(path.join(f.cwd, 'partial.cjs'), 'utf8')
      .replace('second = 1', 'second = 2');
    f.write('partial.cjs', unstaged);
    const result = f.commit();
    if (fail) {
      assert.notEqual(result.status, 0);
      assert.match(result.output, /no-undef/);
      assert.equal(f.git('diff', '--cached'), staged);
      assert.equal(fs.readFileSync(path.join(f.cwd, 'partial.cjs'), 'utf8'), unstaged);
    } else {
      assert.equal(result.status, 0, result.output);
      assert.match(f.git('show', 'HEAD:partial.cjs'), /second = 1/);
      assert.match(fs.readFileSync(path.join(f.cwd, 'partial.cjs'), 'utf8'), /second = 2/);
      assert.equal(f.git('diff', '--cached'), '');
    }
    assert.equal(f.git('stash', 'list'), '');
  });
}

test('setup skips omitted-dev, production, CI and disabled installs without Husky', (t) => {
  const f = fixture(t, false);
  fs.mkdirSync(path.join(f.cwd, '.git'));
  for (const overrides of [
    { npm_config_omit: 'dev' },
    { NODE_ENV: 'production' },
    { CI: 'true' },
    { HUSKY: '0' },
  ]) {
    const result = f.run(process.execPath, [path.join('scripts', 'setup-hooks.cjs')], {
      env: { ...f.env, ...overrides },
    });
    assert.equal(result.status, 0, result.output);
  }
  fs.rmdirSync(path.join(f.cwd, '.git'));
  const result = f.run(process.execPath, [path.join('scripts', 'setup-hooks.cjs')]);
  assert.equal(result.status, 0, result.output);
});

if (manifest.devDependencies['eslint-plugin-react']) {
  test('React conditional hooks and missing dependencies block commits', (t) => {
    const f = fixture(t);
    f.write(
      path.join('src', 'Hooks.js'),
      "import { useEffect } from 'react';\nexport default function Screen({ id }) {\n" +
        'if (id) { useEffect(() => {}, []); }\nuseEffect(() => { console.log(id); }, []);\nreturn null;\n}\n',
    );
    f.git('add', '--', path.join('src', 'Hooks.js'));
    const result = f.commit();
    assert.notEqual(result.status, 0);
    assert.match(result.output, /react-hooks\/rules-of-hooks/);
    assert.match(result.output, /react-hooks\/exhaustive-deps/);
  });
  test('accessibility lint respects web versus React Native primitives', (t) => {
    const f = fixture(t);
    const web = Boolean(manifest.devDependencies['eslint-plugin-jsx-a11y']);
    f.write(
      path.join('src', 'Screen.js'),
      web
        ? 'export default function Screen() { return <img src="bus.png" />; }\n'
        : "import { View } from 'react-native';\nexport default function Screen() { return <View />; }\n",
    );
    f.git('add', '--', path.join('src', 'Screen.js'));
    const result = f.commit();
    if (web) {
      assert.notEqual(result.status, 0);
      assert.match(result.output, /jsx-a11y\/alt-text/);
    } else assert.equal(result.status, 0, result.output);
  });
}
