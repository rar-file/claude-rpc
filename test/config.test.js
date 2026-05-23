// Config loader. Two contracts that matter:
//   1. mergeConfig deep-merges objects but REPLACES arrays. A user's
//      rotation array doesn't get spliced into the defaults.
//   2. loadConfig never throws. Bad JSON / missing file / wrong type
//      all return the merged-defaults object and (optionally) call onError.
//      This is what saves the daemon from a mid-edit save from the Electron
//      GUI — without it, the daemon process.exit(1)'s and stays down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mergeConfig, loadConfig, hasUserConfig } = await import('../src/config.js');
const { DEFAULT_CONFIG } = await import('../src/default-config.js');

// ── mergeConfig ──────────────────────────────────────────────────────

test('mergeConfig: undefined over returns deep clone of base', () => {
  const base = { a: { b: 1 } };
  const out = mergeConfig(base, undefined);
  assert.deepEqual(out, base);
  assert.notEqual(out, base, 'returns a clone, not the same reference');
  assert.notEqual(out.a, base.a, 'nested objects cloned too');
});

test('mergeConfig: scalar over replaces base scalar', () => {
  assert.equal(mergeConfig(1, 2), 2);
  assert.equal(mergeConfig('a', 'b'), 'b');
});

test('mergeConfig: arrays REPLACE (not splice or concat)', () => {
  const out = mergeConfig({ list: [1, 2, 3] }, { list: ['x'] });
  assert.deepEqual(out.list, ['x'], 'array fully replaced, not merged');
});

test('mergeConfig: plain objects deep-merge', () => {
  const base = { presence: { largeImageKey: 'a', byStatus: { working: { details: 'D' }, idle: { state: 'I' } } } };
  const over = { presence: { byStatus: { working: { details: 'OVER' } } } };
  const out = mergeConfig(base, over);
  assert.equal(out.presence.largeImageKey, 'a', 'base key preserved');
  assert.equal(out.presence.byStatus.working.details, 'OVER', 'leaf override applied');
  assert.equal(out.presence.byStatus.idle.state, 'I', 'sibling default preserved');
});

test('mergeConfig: does not mutate inputs', () => {
  const base = { a: { b: 1 } };
  const over = { a: { c: 2 } };
  const baseSnapshot = JSON.parse(JSON.stringify(base));
  const overSnapshot = JSON.parse(JSON.stringify(over));
  mergeConfig(base, over);
  assert.deepEqual(base, baseSnapshot, 'base untouched');
  assert.deepEqual(over, overSnapshot, 'over untouched');
});

// ── loadConfig ───────────────────────────────────────────────────────

function withFile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-cfg-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, contents);
  try { return fn(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

test('loadConfig: missing file returns defaults', () => {
  const errors = [];
  const cfg = loadConfig({ path: '/no/such/path.json', onError: (m) => errors.push(m) });
  assert.equal(cfg.clientId, DEFAULT_CONFIG.clientId);
  assert.deepEqual(errors, [], 'missing file is not an error');
});

test('loadConfig: empty file ({}) returns full defaults', () => {
  withFile('{}', (path) => {
    const cfg = loadConfig({ path });
    assert.equal(cfg.clientId, DEFAULT_CONFIG.clientId);
    assert.equal(cfg.updateIntervalMs, DEFAULT_CONFIG.updateIntervalMs);
    assert.ok(cfg.presence?.byStatus?.working, 'nested defaults present');
  });
});

test('loadConfig: user override merges over defaults', () => {
  withFile(JSON.stringify({ clientId: 'mine', updateIntervalMs: 9999 }), (path) => {
    const cfg = loadConfig({ path });
    assert.equal(cfg.clientId, 'mine');
    assert.equal(cfg.updateIntervalMs, 9999);
    assert.equal(cfg.rotationIntervalMs, DEFAULT_CONFIG.rotationIntervalMs, 'untouched keys keep defaults');
  });
});

test('loadConfig: bad JSON calls onError and falls back to defaults', () => {
  withFile('{not valid', (path) => {
    const errors = [];
    const cfg = loadConfig({ path, onError: (m) => errors.push(m) });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /parse failed/);
    // CRITICAL: still returns a usable config. This is what keeps the
    // daemon alive when the Electron GUI saves a half-written file.
    assert.equal(cfg.clientId, DEFAULT_CONFIG.clientId);
    assert.ok(cfg.presence?.byStatus, 'defaults available');
  });
});

test('loadConfig: non-object JSON falls back', () => {
  withFile('"just a string"', (path) => {
    const errors = [];
    const cfg = loadConfig({ path, onError: (m) => errors.push(m) });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /not an object/);
    assert.equal(cfg.clientId, DEFAULT_CONFIG.clientId);
  });
});

test('loadConfig: nested override preserves sibling defaults', () => {
  // The headline scenario: a v0.3.0 user with only their custom
  // presence.rotation should still get the shipped statusAssets,
  // byStatus, and so on — without any of that being on disk.
  withFile(JSON.stringify({
    clientId: 'mine',
    presence: { rotation: [{ details: 'X', state: 'Y' }] },
  }), (path) => {
    const cfg = loadConfig({ path });
    assert.deepEqual(cfg.presence.rotation, [{ details: 'X', state: 'Y' }]);
    assert.ok(cfg.presence.byStatus?.working, 'default byStatus available');
    assert.ok(cfg.statusAssets?.working, 'default statusAssets available');
    assert.equal(cfg.clientId, 'mine');
  });
});

// ── hasUserConfig ────────────────────────────────────────────────────

test('hasUserConfig: false for missing path', () => {
  assert.equal(hasUserConfig('/no/such/path.json'), false);
});

test('hasUserConfig: true when file exists (any content)', () => {
  withFile('{}', (path) => assert.equal(hasUserConfig(path), true));
});
