const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'build/**',
      'dist/**',
      'coverage/**',
      'uploads/**',
      'android/**',
      'ios/**',
      '.husky/**',
      '**/*.min.js',
    ],
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: globals.node },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  { files: ['**/*.mjs'], languageOptions: { sourceType: 'module' } },
  { files: ['tests/**/*.js', 'jest.config.js'], languageOptions: { globals: globals.jest } },
  prettier,
];
