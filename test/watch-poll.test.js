// Unit coverage for the daemon's mtime-poll fallback logic (src/watch-poll.js).
// The daemon itself can't be imported under test (it boots on import), so the
// poll's decision rule and platform-aware cadence live in this pure module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pollDecision,
  pollIntervalMs,
  WATCH_POLL_MS,
  WATCH_POLL_WIN_MS,
} from '../src/watch-poll.js';

test('pollIntervalMs: Windows polls fast, others lazily', () => {
  assert.equal(pollIntervalMs('win32'), WATCH_POLL_WIN_MS);
  assert.equal(pollIntervalMs('darwin'), WATCH_POLL_MS);
  assert.equal(pollIntervalMs('linux'), WATCH_POLL_MS);
  // Windows must be the faster cadence — that's the whole point of the split.
  assert.ok(WATCH_POLL_WIN_MS < WATCH_POLL_MS);
});

test('pollDecision: first observation only seeds the baseline', () => {
  assert.equal(pollDecision(undefined, 1000), 'seed');
});

test('pollDecision: advanced mtime fires (watcher missed the event)', () => {
  assert.equal(pollDecision(1000, 2000), 'fire');
});

test('pollDecision: unchanged mtime is idle (watcher already handled it)', () => {
  assert.equal(pollDecision(1000, 1000), 'idle');
});

test('pollDecision: a backwards mtime does not fire', () => {
  // File replaced with an older copy (restore/clock skew). Atomic writers
  // only ever move mtime forward, so this is never a real change to react to.
  assert.equal(pollDecision(2000, 1000), 'idle');
});

test('pollDecision: absent / stat-failed file is idle even before a baseline', () => {
  assert.equal(pollDecision(undefined, undefined), 'idle');
  assert.equal(pollDecision(1000, undefined), 'idle');
});
