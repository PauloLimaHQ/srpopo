const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

// Same intent as before: unused vars are a warning, `_`-prefixed ones are ignored.
const unused = ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }];

module.exports = tseslint.config(
  {
    ignores: ['node_modules/**', 'release/**', 'data/**', 'build/**', 'dist/**', 'public/vendor/**'],
  },
  {
    // TypeScript Node-side code: the Express server, the Electron shell, and the
    // test suite. `extends` scopes the TS parser + recommended rules to just
    // these files so the vanilla-JS globs below keep the default parser.
    files: ['server/**/*.ts', 'electron/**/*.ts', 'tests/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'off', // TypeScript checks this and knows the Node/DOM globals.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': unused,
      // Pragmatic during the JS→TS migration: some CLI/stream-json shapes stay `any`.
      '@typescript-eslint/no-explicit-any': 'off',
      // main.ts / tests use require() in place to control module load order.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // The Electron preload straddles Node + the DOM.
    files: ['electron/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Plain-Node JS that intentionally stays JS: the permission bridge (spawned
    // as a standalone Node process) and this config file.
    files: ['server/**/*.js', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: { 'no-unused-vars': unused },
  },
  {
    // Browser-side renderer code: vanilla JS, still no build step — the board is
    // split into native ES modules (public/app.js + core/ + features/), loaded
    // with <script type="module">.
    files: ['public/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: { 'no-unused-vars': unused },
  },
  {
    // icons.js is loaded as a classic script before the module graph, so it
    // publishes `window.srpopoIcons` instead of exporting.
    files: ['public/icons.js'],
    languageOptions: { sourceType: 'script' },
  },
);
