// Regression tests for findConfigPath() priority order (issue #16).
//
// Re-derives the candidate-list logic with injectable context so we can probe
// it without pulling in Electron.  Must mirror dashboard/main.js findConfigPath().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

function findConfigPath(ctx, fileExists) {
  const { isPackaged, cwd, exeDir, userConfig, devExtras = [] } = ctx;
  const candidates = isPackaged
    ? [
        userConfig,
        join(exeDir, 'config.json'),
        join(exeDir, '..', 'config.json'),
      ]
    : [
        join(cwd, 'config.json'),
        join(exeDir, 'config.json'),
        join(exeDir, '..', 'config.json'),
        ...devExtras,
        userConfig,
      ];
  for (const c of candidates) {
    if (fileExists(c)) return c;
  }
  return null;
}

// ── packaged mode ─────────────────────────────────────────────────────────────

test('packaged: stray cwd/config.json does NOT shadow user config (regression #16)', () => {
  const ctx = {
    isPackaged: true,
    cwd: '/some/random/working/dir',
    exeDir: '/usr/local/bin',
    userConfig: '/home/user/.config/claude-rpc/config.json',
  };
  // Both cwd config and user config "exist" — user config must win.
  const existing = new Set([join(ctx.cwd, 'config.json'), ctx.userConfig]);
  assert.equal(findConfigPath(ctx, (p) => existing.has(p)), ctx.userConfig);
});

test('packaged: only user config exists → returns user config', () => {
  const ctx = {
    isPackaged: true,
    cwd: '/some/dir',
    exeDir: '/usr/local/bin',
    userConfig: '/home/user/.config/claude-rpc/config.json',
  };
  assert.equal(findConfigPath(ctx, (p) => p === ctx.userConfig), ctx.userConfig);
});

test('packaged: user config absent, exe-relative exists → returns exe-relative', () => {
  const ctx = {
    isPackaged: true,
    cwd: '/some/dir',
    exeDir: '/usr/local/bin',
    userConfig: '/home/user/.config/claude-rpc/config.json',
  };
  const exeRelative = join(ctx.exeDir, 'config.json');
  assert.equal(findConfigPath(ctx, (p) => p === exeRelative), exeRelative);
});

test('packaged: nothing exists → returns null', () => {
  const ctx = {
    isPackaged: true,
    cwd: '/some/dir',
    exeDir: '/usr/local/bin',
    userConfig: '/home/user/.config/claude-rpc/config.json',
  };
  assert.equal(findConfigPath(ctx, () => false), null);
});

// ── dev mode ──────────────────────────────────────────────────────────────────

test('dev: cwd/config.json wins over user config (backwards-compat)', () => {
  const ctx = {
    isPackaged: false,
    cwd: '/home/user/projects/claude-rpc',
    exeDir: '/usr/local/bin',
    userConfig: '/home/user/.config/claude-rpc/config.json',
  };
  const cwdConfig = join(ctx.cwd, 'config.json');
  const existing = new Set([cwdConfig, ctx.userConfig]);
  assert.equal(findConfigPath(ctx, (p) => existing.has(p)), cwdConfig);
});

test('dev: only user config exists → returns user config', () => {
  const ctx = {
    isPackaged: false,
    cwd: '/home/user/projects/something-else',
    exeDir: '/usr/local/bin',
    userConfig: '/home/user/.config/claude-rpc/config.json',
  };
  assert.equal(findConfigPath(ctx, (p) => p === ctx.userConfig), ctx.userConfig);
});

test('dev: nothing exists → returns null', () => {
  const ctx = {
    isPackaged: false,
    cwd: '/home/user/projects/claude-rpc',
    exeDir: '/usr/local/bin',
    userConfig: '/home/user/.config/claude-rpc/config.json',
  };
  assert.equal(findConfigPath(ctx, () => false), null);
});
