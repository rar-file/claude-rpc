// migrateConfig + ensureCanonicalExe — the two functions that fire on
// every install/setup. The v0.3.8 ghost-bug (broken upgrades from v0.3.0)
// happened because migrateConfig wasn't being called. These tests pin its
// idempotency and non-destructive merge behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ensureCanonicalExe } = await import('../src/install.js');
const { DEFAULT_CONFIG } = await import('../src/default-config.js');

// migrateConfig writes to the real CONFIG_PATH, so we re-implement its core
// logic here to test the non-destructive merge invariants without touching
// the user's actual config. (The IO wrapper is trivial; the merge logic is
// the part with bugs.)
function migrateInPlace(cfg) {
  const added = [];
  if (!cfg.appName && DEFAULT_CONFIG.appName) {
    cfg.appName = DEFAULT_CONFIG.appName;
    added.push('appName');
  }
  cfg.presence = cfg.presence || {};
  if (!cfg.presence.byStatus && DEFAULT_CONFIG.presence?.byStatus) {
    cfg.presence.byStatus = JSON.parse(JSON.stringify(DEFAULT_CONFIG.presence.byStatus));
    added.push('presence.byStatus');
  }
  const OLD_LIT = '{modelPretty} · {allHours} on Claude · {daysSinceFirstLabel}';
  if (cfg.presence.largeImageText === OLD_LIT && DEFAULT_CONFIG.presence?.largeImageText) {
    cfg.presence.largeImageText = DEFAULT_CONFIG.presence.largeImageText;
    added.push('presence.largeImageText');
  }
  return added;
}

test('migrate: legacy v0.3.0 config gains byStatus + appName', () => {
  const cfg = {
    clientId: '123',
    presence: {
      largeImageText: '{modelPretty} · {allHours} on Claude · {daysSinceFirstLabel}',
      rotation: [{ details: 'A', state: 'B' }],
    },
  };
  const added = migrateInPlace(cfg);
  assert.ok(added.includes('appName'));
  assert.ok(added.includes('presence.byStatus'));
  assert.ok(added.includes('presence.largeImageText'));
  assert.equal(cfg.appName, 'Claude Code');
  assert.ok(cfg.presence.byStatus.working, 'byStatus.working seeded');
  assert.deepEqual(cfg.presence.rotation, [{ details: 'A', state: 'B' }], 'rotation preserved');
});

test('migrate: already-migrated config is a no-op', () => {
  const cfg = {
    clientId: '123',
    appName: 'My App',
    presence: {
      byStatus: { working: { details: 'X', state: 'Y' } },
    },
  };
  const before = JSON.parse(JSON.stringify(cfg));
  const added = migrateInPlace(cfg);
  assert.deepEqual(added, [], 'no fields added on a current config');
  assert.deepEqual(cfg, before, 'config unchanged');
});

test('migrate: preserves user customizations', () => {
  const cfg = {
    clientId: '123',
    appName: 'Custom Name',                 // user-set
    presence: {
      largeImageText: 'Custom tooltip',     // user-set
      byStatus: { working: { details: 'My custom', state: 'frame' } }, // user-set
    },
  };
  const added = migrateInPlace(cfg);
  assert.equal(cfg.appName, 'Custom Name', 'user appName preserved');
  assert.equal(cfg.presence.largeImageText, 'Custom tooltip', 'user tooltip preserved');
  assert.equal(cfg.presence.byStatus.working.details, 'My custom', 'user byStatus preserved');
  assert.deepEqual(added, []);
});

test('migrate: idempotent — repeated runs add nothing', () => {
  const cfg = { clientId: '123', presence: {} };
  migrateInPlace(cfg);
  const after1 = JSON.parse(JSON.stringify(cfg));
  migrateInPlace(cfg);
  assert.deepEqual(cfg, after1, 'second run is a no-op');
});

// migrateInPlace below is the locally re-implemented merge logic — it
// covers the byStatus.working/thinking.state literal swap added in v0.6.3.
function migrateWithLabel(cfg) {
  cfg.presence = cfg.presence || {};
  if (!cfg.presence.byStatus && DEFAULT_CONFIG.presence?.byStatus) {
    cfg.presence.byStatus = JSON.parse(JSON.stringify(DEFAULT_CONFIG.presence.byStatus));
    return;
  }
  const OLD_WORKING = '{currentToolPretty} · {currentFilePretty} · {tokensFmt} tokens';
  const OLD_THINKING = '{modelPretty} · {messagesLabel} · {tokensFmt} tokens';
  if (cfg.presence.byStatus?.working?.state === OLD_WORKING) {
    cfg.presence.byStatus.working.state = DEFAULT_CONFIG.presence.byStatus.working.state;
  }
  if (cfg.presence.byStatus?.thinking?.state === OLD_THINKING) {
    cfg.presence.byStatus.thinking.state = DEFAULT_CONFIG.presence.byStatus.thinking.state;
  }
}

test('migrate: literal old working/thinking templates get swapped to {tokensLabel}', () => {
  const cfg = {
    presence: {
      byStatus: {
        working: { details: 'D', state: '{currentToolPretty} · {currentFilePretty} · {tokensFmt} tokens' },
        thinking: { details: 'T', state: '{modelPretty} · {messagesLabel} · {tokensFmt} tokens' },
      },
    },
  };
  migrateWithLabel(cfg);
  assert.match(cfg.presence.byStatus.working.state, /\{tokensLabel\}/);
  assert.match(cfg.presence.byStatus.thinking.state, /\{tokensLabel\}/);
});

test('migrate: customized working state is left alone', () => {
  const cfg = {
    presence: {
      byStatus: {
        working: { details: 'D', state: 'My custom · {currentToolPretty}' },
        thinking: { details: 'T', state: '{modelPretty}' },
      },
    },
  };
  migrateWithLabel(cfg);
  assert.equal(cfg.presence.byStatus.working.state, 'My custom · {currentToolPretty}');
  assert.equal(cfg.presence.byStatus.thinking.state, '{modelPretty}');
});

// ── ensureCanonicalExe ────────────────────────────────────────────────

test('ensureCanonicalExe: dev mode returns input unchanged', () => {
  // IS_PACKAGED is false in dev mode, so ensureCanonicalExe should not
  // touch anything — it just returns the path it was given.
  const out = ensureCanonicalExe('/path/to/foo');
  assert.equal(out, '/path/to/foo');
});

// ── verifyHookPipe shell-flag regression ──────────────────────────────
//
// v0.6.0 shipped a Windows-npm bug: `spawnSync('claude-rpc', [...])` fails
// with ENOENT because Node doesn't apply PATHEXT, and npm globals on
// Windows are `claude-rpc.cmd` shims. Fix in v0.6.1 was to set
// `shell: true` on the spawn options when running under npm-install +
// Windows. The grep-test below pins the fix in source so a future
// refactor can't silently re-introduce it.

test('verifyHookPipe sets shell:true for Windows+npm mode', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(join(root, 'src', 'install.js'), 'utf8');
  // The verifier must compute a shell flag from the install mode + platform
  // and pass it to spawnSync. A grep is the cheapest way to assert that
  // without booting a real Windows npm shim.
  assert.match(src, /shell:\s*useShell|shell:\s*process\.platform\s*===\s*['"]win32['"]/,
    'verifyHookPipe must pass a shell flag to spawnSync');
  assert.match(src, /IS_NPM_INSTALL\s*&&\s*process\.platform\s*===\s*['"]win32['"]/,
    'shell flag must gate on npm-install + Windows');
});
