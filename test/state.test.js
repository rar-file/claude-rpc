// State file IO + helpers. The state.json shape is the live contract
// between hook events and the daemon — regressions here ripple everywhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Re-import after mutating env so STATE_PATH points at a temp dir per test
// suite. State module reads paths at import time, so we spawn a child via
// dynamic import after the TMPDIR override. Simplest workaround: each test
// uses its own temp dir but operates through the same module — paths are
// frozen, so writes go to the real /tmp/claude-rpc/state.json. To keep these
// tests hermetic we operate on the raw functions directly rather than the
// IO wrappers. updateState/resetState write to STATE_PATH, so we ONLY test
// the pure helpers (pushUnique, shortFile) and round-trip with the actual
// state file isolated to this test.

const { pushUnique, shortFile } = await import('../src/state.js');

test('pushUnique adds to front and dedupes', () => {
  const a = pushUnique([], '/a.js');
  assert.deepEqual(a, ['/a.js']);

  const b = pushUnique(['/a.js', '/b.js'], '/c.js');
  assert.deepEqual(b, ['/c.js', '/a.js', '/b.js']);

  const c = pushUnique(['/c.js', '/a.js', '/b.js'], '/a.js');
  assert.deepEqual(c, ['/a.js', '/c.js', '/b.js'], 'existing item moves to front');
});

test('pushUnique respects max cap', () => {
  const arr = ['1', '2', '3', '4', '5'];
  const out = pushUnique(arr, 'new', 3);
  assert.equal(out.length, 3);
  assert.equal(out[0], 'new');
});

test('pushUnique drops falsy values', () => {
  assert.deepEqual(pushUnique(['/a.js'], null), ['/a.js']);
  assert.deepEqual(pushUnique(['/a.js'], ''), ['/a.js']);
  assert.deepEqual(pushUnique(['/a.js'], undefined), ['/a.js']);
});

test('shortFile returns basename', () => {
  assert.equal(shortFile('/path/to/file.js'), 'file.js');
  // Node's path.basename uses platform-specific separators; on POSIX it only
  // splits on '/' so '\\'-paths are returned whole. Hooks normalize before
  // calling, so this matches real-world usage.
  assert.equal(shortFile(null), null);
  assert.equal(shortFile(''), null);
});

// ── readState / writeState / updateState round-trip ─────────────────
//
// These touch the real STATE_PATH (shared across tests within the process).
// We round-trip a synthetic value and restore the prior state at the end
// so we don't leak into other test files' assumptions. The point is to
// pin the atomic-rename pattern in writeState — a regression there
// (e.g. dropping the .tmp) would silently lose state under crash, and
// no other test would catch it.

const { readState, writeState, updateState, resetState, readActiveState, statePathFor } = await import('../src/state.js');

test('writeState + readState round-trip preserves shape', () => {
  const before = readState();
  try {
    writeState({ ...before, model: 'TEST-MODEL-ROUNDTRIP' });
    const after = readState();
    assert.equal(after.model, 'TEST-MODEL-ROUNDTRIP');
  } finally {
    writeState(before);
  }
});

test('updateState applies the mutator', () => {
  const before = readState();
  try {
    updateState((s) => { s.messages = 9999; return s; });
    assert.equal(readState().messages, 9999);
  } finally {
    writeState(before);
  }
});

test('resetState seeds DEFAULT_STATE with overrides', () => {
  const before = readState();
  try {
    const fresh = resetState({ cwd: '/test/cwd', model: 'test-model' });
    assert.equal(fresh.cwd, '/test/cwd');
    assert.equal(fresh.model, 'test-model');
    assert.equal(fresh.messages, 0, 'counters zero on reset');
  } finally {
    writeState(before);
  }
});

test('readActiveState resolves the active per-session file, not the empty global', () => {
  // Guards a v0.18.0 regression: status / serve / tui read bare readState()
  // (the global state.json), which per-session hooks — always carrying a
  // session_id — never write, so the inspection surfaces showed an empty
  // session mid-work. The daemon resolved per-session; the readers must too.
  const sid = 'test-active-' + process.pid;
  const path = statePathFor(sid);
  try {
    writeState({ status: 'working', cwd: '/demo/acme-api', model: 'claude-opus-4-8', messages: 7, lastActivity: Date.now() }, sid);
    const active = readActiveState();
    assert.equal(active.status, 'working', 'picks the live per-session state, not the global');
    assert.equal(active.cwd, '/demo/acme-api');
    assert.equal(active.messages, 7);
  } finally {
    try { unlinkSync(path); } catch { /* already gone */ }
  }
});
