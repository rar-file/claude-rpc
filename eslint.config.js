import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat ESLint config. The goal is a useful safety net (catch undefined vars,
 * unreachable code, real mistakes) without forcing a stylistic rewrite of an
 * already-consistent codebase — so a few rules that fight this project's
 * deliberate idioms (best-effort empty catches, `for (;;)` spin loops) are
 * relaxed, and cosmetic things are left to Prettier.
 */
export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'dashboard/**',
      'worker/**',
      'site/**',
      'tools/**',
      'launch/**',
      'scripts/og-image.svg',
      '**/*.min.js',
    ],
  },
  js.configs.recommended,
  {
    // Node ESM — the daemon, CLI, scanner, server, etc.
    files: ['src/**/*.js', 'test/**/*.js', 'bin/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Best-effort I/O all over this codebase uses `try { ... } catch {}`.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // state.js / mcp.js use intentional `for (;;)` and `while (true)` loops.
      'no-constant-condition': ['error', { checkLoops: false }],
      // tui.js / cli.js strip ANSI escapes with regexes containing \x1b.
      'no-control-regex': 'off',
      // Surface dead bindings without failing the build on them.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // VS Code extension — CommonJS (the extension host's native module
    // format; the folder's package.json has no "type" field on purpose).
    files: ['vscode-extension/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Browser-side assets served by the dashboard web server.
    files: ['src/server/assets/**/*.client.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
];
