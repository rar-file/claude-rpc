// Regression test for https://github.com/rar-file/claude-rpc/issues/15
//
// dashboard/renderer.js is a browser-only vanilla script and cannot be imported
// in Node. The collectTiming logic is mirrored here as a pure function so the
// critical invariants can be exercised without a DOM. If collectTiming in
// renderer.js changes, keep this mirror in sync.

import { test } from 'node:test';
import assert from 'node:assert/strict';

function collectTiming(rows, into) {
  for (const { key, mul, raw } of rows) {
    if (raw === '') { delete into[key]; continue; }
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) into[key] = Math.round(n * mul);
  }
}

test('set value: key is written with multiplier applied', () => {
  const cfg = {};
  collectTiming([{ key: 'updateIntervalMs', mul: 1000, raw: '5' }], cfg);
  assert.equal(cfg.updateIntervalMs, 5000);
});

test('empty input: key is deleted from config (regression #15)', () => {
  const cfg = { updateIntervalMs: 5000 };
  collectTiming([{ key: 'updateIntervalMs', mul: 1000, raw: '' }], cfg);
  assert.equal('updateIntervalMs' in cfg, false,
    'key must be removed so loadConfig falls back to the baked default');
});

test('empty input on absent key: remains absent', () => {
  const cfg = {};
  collectTiming([{ key: 'updateIntervalMs', mul: 1000, raw: '' }], cfg);
  assert.equal('updateIntervalMs' in cfg, false);
});

test('non-numeric input: existing value preserved', () => {
  const cfg = { updateIntervalMs: 5000 };
  collectTiming([{ key: 'updateIntervalMs', mul: 1000, raw: 'abc' }], cfg);
  assert.equal(cfg.updateIntervalMs, 5000);
});

test('zero input: existing value preserved (zero is not positive)', () => {
  const cfg = { updateIntervalMs: 5000 };
  collectTiming([{ key: 'updateIntervalMs', mul: 1000, raw: '0' }], cfg);
  assert.equal(cfg.updateIntervalMs, 5000);
});

test('negative input: existing value preserved', () => {
  const cfg = { updateIntervalMs: 5000 };
  collectTiming([{ key: 'updateIntervalMs', mul: 1000, raw: '-1' }], cfg);
  assert.equal(cfg.updateIntervalMs, 5000);
});

test('multiple rows handled independently', () => {
  const cfg = { updateIntervalMs: 5000, rotationIntervalMs: 8000 };
  collectTiming([
    { key: 'updateIntervalMs', mul: 1000, raw: '' },      // cleared → deleted
    { key: 'rotationIntervalMs', mul: 1000, raw: '10' },  // set → updated
  ], cfg);
  assert.equal('updateIntervalMs' in cfg, false, 'cleared key removed');
  assert.equal(cfg.rotationIntervalMs, 10000, 'set key updated with multiplier');
});
