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
  // Button defaults moved claude.com → repo (v0.8.1) → landing CTA (v0.13).
  // Upgrade verbatim shipped defaults wholesale; repoint a relabeled-but-dead
  // claude.com link; leave fully-customized buttons alone. Mirrors install.js.
  const NEW_BTN = DEFAULT_CONFIG.presence?.buttons?.[0];
  const SHIPPED_DEFAULT_BTNS = [
    { label: 'Claude Code', url: 'https://claude.com/claude-code' },
    { label: 'Claude Code', url: 'https://github.com/rar-file/claude-rpc' },
  ];
  if (NEW_BTN && Array.isArray(cfg.presence?.buttons)) {
    let changed = false;
    for (const b of cfg.presence.buttons) {
      if (!b) continue;
      const isShippedDefault = SHIPPED_DEFAULT_BTNS.some((d) => d.label === b.label && d.url === b.url);
      const alreadyCurrent = b.label === NEW_BTN.label && b.url === NEW_BTN.url;
      if (isShippedDefault && !alreadyCurrent) {
        b.label = NEW_BTN.label; b.url = NEW_BTN.url; changed = true;
      } else if (b.url === 'https://claude.com/claude-code') {
        b.url = NEW_BTN.url; changed = true;
      }
    }
    if (changed) added.push('presence.buttons[] → CTA');
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

test('migrate: legacy claude.com default button is upgraded wholesale to the CTA', () => {
  const cfg = {
    clientId: '123', appName: 'Claude Code',
    presence: {
      byStatus: { working: { details: 'X', state: 'Y' } },
      buttons: [{ label: 'Claude Code', url: 'https://claude.com/claude-code' }],
    },
  };
  const added = migrateInPlace(cfg);
  assert.ok(added.includes('presence.buttons[] → CTA'), 'button migrated');
  assert.deepEqual(cfg.presence.buttons[0], DEFAULT_CONFIG.presence.buttons[0],
    'matches the current default CTA (label + url)');
});

test('migrate: v0.8.1 repo default button is upgraded to the CTA', () => {
  const cfg = {
    clientId: '123', appName: 'Claude Code',
    presence: {
      byStatus: { working: { details: 'X', state: 'Y' } },
      buttons: [{ label: 'Claude Code', url: 'https://github.com/rar-file/claude-rpc' }],
    },
  };
  const added = migrateInPlace(cfg);
  assert.ok(added.includes('presence.buttons[] → CTA'), 'button migrated');
  assert.deepEqual(cfg.presence.buttons[0], DEFAULT_CONFIG.presence.buttons[0]);
});

test('migrate: a relabeled-but-dead claude.com link gets repointed, label kept', () => {
  const cfg = {
    clientId: '123', appName: 'Claude Code',
    presence: {
      byStatus: { working: { details: 'X', state: 'Y' } },
      buttons: [{ label: 'My Custom Label', url: 'https://claude.com/claude-code' }],
    },
  };
  const added = migrateInPlace(cfg);
  assert.ok(added.includes('presence.buttons[] → CTA'), 'dead link repointed');
  assert.equal(cfg.presence.buttons[0].url, DEFAULT_CONFIG.presence.buttons[0].url);
  assert.equal(cfg.presence.buttons[0].label, 'My Custom Label', 'custom label preserved');
});

test('migrate: a fully user-customized button is left untouched', () => {
  const cfg = {
    clientId: '123', appName: 'Claude Code',
    presence: {
      byStatus: { working: { details: 'X', state: 'Y' } },
      buttons: [{ label: 'My Site', url: 'https://example.com' }],
    },
  };
  const added = migrateInPlace(cfg);
  assert.ok(!added.includes('presence.buttons[] → CTA'), 'custom button not touched');
  assert.equal(cfg.presence.buttons[0].url, 'https://example.com');
  assert.equal(cfg.presence.buttons[0].label, 'My Site');
});

test('migrate: a config already on the CTA button is a no-op', () => {
  const cfg = {
    clientId: '123', appName: 'Claude Code',
    presence: {
      byStatus: { working: { details: 'X', state: 'Y' } },
      buttons: [{ ...DEFAULT_CONFIG.presence.buttons[0] }],
    },
  };
  const added = migrateInPlace(cfg);
  assert.ok(!added.includes('presence.buttons[] → CTA'), 'no churn when already current');
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

// ── v0.7 community preserve-off-for-upgraders ─────────────────────────
//
// DEFAULT_CONFIG.community.enabled flipped to true in v0.7. The deep
// merge in loadConfig would silently enable telemetry for any pre-v0.7
// user whose config has no community block. migrateConfig MUST write an
// explicit { enabled: false } into their file before that can happen.

function migrateCommunity(cfg) {
  const added = [];
  if (!cfg.community) {
    cfg.community = { enabled: false };
    added.push('community (preserved-off)');
  }
  return added;
}

test('migrate: pre-v0.7 config without community block gets explicit enabled:false', () => {
  const cfg = { clientId: '123', presence: { byStatus: { working: {} } } };
  const added = migrateCommunity(cfg);
  assert.equal(cfg.community.enabled, false,
    'upgrader must NOT silently inherit the new on-by-default');
  assert.ok(added.includes('community (preserved-off)'));
});

test('migrate: an explicit user community block is left untouched', () => {
  const cfg = {
    clientId: '123',
    community: { enabled: true, instanceId: 'aaaa-bbbb-cccc', endpoint: 'https://custom' },
  };
  const before = JSON.parse(JSON.stringify(cfg.community));
  const added = migrateCommunity(cfg);
  assert.deepEqual(cfg.community, before, 'pre-existing community block preserved');
  assert.deepEqual(added, [], 'no migration entry when block already present');
});

test('migrate: opted-out user (enabled:false) is not flipped on', () => {
  const cfg = { clientId: '123', community: { enabled: false, instanceId: 'kept' } };
  const before = JSON.parse(JSON.stringify(cfg.community));
  migrateCommunity(cfg);
  assert.deepEqual(cfg.community, before, 'opt-out preserved across migration');
});

// ── seedConfig: fresh install mints an instanceId ────────────────────
//
// seedConfig writes DEFAULT_CONFIG to disk on first run. v0.7 added a
// mint step so the freshly-seeded `community.enabled: true` is actually
// actionable — without an instanceId the daemon's flushCommunity bails
// with no-instance-id. Re-implement the mint-on-seed logic here for
// hermetic assertion.

function seedInPlace(defaults, randomUuid) {
  const seeded = JSON.parse(JSON.stringify(defaults));
  if (seeded.community?.enabled && !seeded.community.instanceId) {
    seeded.community.instanceId = randomUuid();
  }
  return seeded;
}

test('seed: fresh install with community.enabled mints an instanceId', () => {
  const fakeUuid = () => '11111111-2222-4333-8444-555555555555';
  const seeded = seedInPlace(DEFAULT_CONFIG, fakeUuid);
  assert.equal(seeded.community.enabled, true,
    'precondition — DEFAULT_CONFIG flipped to enabled:true in v0.7');
  assert.equal(seeded.community.instanceId, '11111111-2222-4333-8444-555555555555',
    'instanceId minted at seed time');
});

test('seed: does not overwrite a pre-existing instanceId in defaults', () => {
  const defaults = {
    community: { enabled: true, instanceId: 'pre-existing-id' },
  };
  const seeded = seedInPlace(defaults, () => 'should-not-be-called');
  assert.equal(seeded.community.instanceId, 'pre-existing-id');
});

test('seed: enabled:false in defaults does not mint', () => {
  const defaults = { community: { enabled: false, instanceId: null } };
  const seeded = seedInPlace(defaults, () => 'should-not-be-called');
  assert.equal(seeded.community.instanceId, null);
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

// ── v0.12.1: MCP server command resolution ──────────────────────────────
const { mcpServerCommand } = await import('../src/install.js');
test('mcpServerCommand: resolves a runnable {command, args} ending in mcp', () => {
  const r = mcpServerCommand('/some/exe');
  assert.ok(r.command, 'has a command');
  assert.ok(Array.isArray(r.args));
  assert.equal(r.args[r.args.length - 1], 'mcp', 'last arg is the mcp subcommand');
});
