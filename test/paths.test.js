// paths.js — mode detection. The v0.3.9 trilemma (packaged / npm / dev)
// is wired here. If the detection regex breaks, half the install/setup
// logic routes to the wrong CONFIG_PATH and the wrong hook command shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Re-derive the detection logic so we can probe it with synthetic paths
// without re-importing paths.js (which freezes IS_PACKAGED at module-load
// time from the current process). This pins the *regex contract*, not the
// runtime value.

function detectMode(rootPath, execPath) {
  const IS_PACKAGED = !/[\\/]node(\.exe)?$/i.test(execPath);
  const IS_NPM_INSTALL = !IS_PACKAGED && /[\\/]node_modules[\\/]/i.test(rootPath);
  return IS_PACKAGED ? 'packaged' : IS_NPM_INSTALL ? 'npm' : 'dev';
}

// npx is an npm-install whose root sits in npm's ephemeral _npx cache.
function isNpx(rootPath, execPath) {
  return detectMode(rootPath, execPath) === 'npm' && /[\\/]_npx[\\/]/i.test(rootPath);
}

test('mode: npm global on Windows nvm', () => {
  assert.equal(
    detectMode(
      'C:\\Users\\foo\\AppData\\Local\\nvm\\v20.20.0\\node_modules\\claude-rpc',
      'C:\\nvm4w\\nodejs\\node.exe'
    ),
    'npm'
  );
});

test('mode: npm global on Linux/macOS', () => {
  assert.equal(detectMode('/usr/local/lib/node_modules/claude-rpc', '/usr/local/bin/node'), 'npm');
  assert.equal(detectMode('/opt/homebrew/lib/node_modules/claude-rpc', '/opt/homebrew/bin/node'), 'npm');
});

test('mode: cloned source tree → dev', () => {
  assert.equal(detectMode('/home/foo/projects/claude-rpc', '/usr/local/bin/node'), 'dev');
  assert.equal(detectMode('C:\\Users\\foo\\code\\claude-rpc', 'C:\\Program Files\\nodejs\\node.exe'), 'dev');
});

test('mode: SEA exe on Windows', () => {
  assert.equal(
    detectMode(
      'C:\\Users\\foo\\AppData\\Roaming\\claude-rpc',
      'C:\\Users\\foo\\AppData\\Roaming\\claude-rpc\\bin\\claude-rpc.exe'
    ),
    'packaged'
  );
});

test('mode: SEA exe on macOS', () => {
  assert.equal(
    detectMode(
      '/Applications/Claude RPC.app/Contents/Resources/bin',
      '/Applications/Claude RPC.app/Contents/Resources/bin/claude-rpc'
    ),
    'packaged'
  );
});

test('mode: SEA exe on Linux', () => {
  assert.equal(
    detectMode(
      '/home/foo/.config/claude-rpc/bin',
      '/home/foo/.config/claude-rpc/bin/claude-rpc'
    ),
    'packaged'
  );
});

test('npx: _npx cache path is detected as npx (and as npm mode)', () => {
  const root = '/home/foo/.npm/_npx/a1b2c3d4e5f6/node_modules/claude-rpc';
  const exe = '/home/foo/.nvm/versions/node/v20.0.0/bin/node';
  assert.equal(detectMode(root, exe), 'npm', 'npx is an npm-mode install');
  assert.equal(isNpx(root, exe), true, 'but flagged as ephemeral npx');
});

test('npx: a real global npm install is NOT flagged as npx', () => {
  const root = '/usr/local/lib/node_modules/claude-rpc';
  const exe = '/usr/local/bin/node';
  assert.equal(detectMode(root, exe), 'npm');
  assert.equal(isNpx(root, exe), false, 'persistent global install is not npx');
});

test('npx: Windows _npx cache path is detected', () => {
  const root = 'C:\\Users\\foo\\AppData\\Local\\npm-cache\\_npx\\abcdef\\node_modules\\claude-rpc';
  const exe = 'C:\\Program Files\\nodejs\\node.exe';
  assert.equal(isNpx(root, exe), true);
});

test('mode: npm-install path beats node-as-exe heuristic', () => {
  // Critical: even though execPath ends in `node`, a node_modules path
  // wrapping the source means npm-install, not dev.
  const m = detectMode(
    '/Users/foo/.npm-global/lib/node_modules/claude-rpc',
    '/Users/foo/.nvm/versions/node/v20.0.0/bin/node'
  );
  assert.equal(m, 'npm');
});
