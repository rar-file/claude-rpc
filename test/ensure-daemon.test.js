// ensure-daemon.js — the startup-assurance primitives: the hook's self-heal
// decision (shouldSpawnDaemon), the daemon's race-proof single-instance claim
// (claimSingleInstance), and the liveness probe (isAlive). spawnDaemonDetached /
// ensureDaemonRunning launch a real detached process, so they're exercised
// end-to-end elsewhere; here we cover the pure logic + the fs-level claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { shouldSpawnDaemon, claimSingleInstance, isAlive } = await import('../src/ensure-daemon.js');

const NOW = 1_000_000;
const COOL = 15_000;

// ── shouldSpawnDaemon (hook self-heal decision) ────────────────────────
test('shouldSpawnDaemon: down + autostart on + no recent attempt → spawn', () => {
  assert.equal(shouldSpawnDaemon({ autostart: true, daemonPid: 0, lastAttemptMs: 0, now: NOW, cooldownMs: COOL }), true);
});
test('shouldSpawnDaemon: autostart off → never', () => {
  assert.equal(shouldSpawnDaemon({ autostart: false, daemonPid: 0, lastAttemptMs: 0, now: NOW, cooldownMs: COOL }), false);
});
test('shouldSpawnDaemon: a daemon already alive → never', () => {
  assert.equal(shouldSpawnDaemon({ autostart: true, daemonPid: 4321, lastAttemptMs: 0, now: NOW, cooldownMs: COOL }), false);
});
test('shouldSpawnDaemon: inside the cooldown → suppressed (storm / crash-loop guard)', () => {
  assert.equal(shouldSpawnDaemon({ autostart: true, daemonPid: 0, lastAttemptMs: NOW - 5_000, now: NOW, cooldownMs: COOL }), false);
});
test('shouldSpawnDaemon: cooldown elapsed → spawn again', () => {
  assert.equal(shouldSpawnDaemon({ autostart: true, daemonPid: 0, lastAttemptMs: NOW - 20_000, now: NOW, cooldownMs: COOL }), true);
});

// ── isAlive ────────────────────────────────────────────────────────────
test('isAlive: this process is alive; an absurd pid / 0 / NaN are not', () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2_000_000_000), false); // far above any OS pid_max
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(NaN), false);
});

// ── claimSingleInstance (race-proof single-instance) ───────────────────
function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), 'crpc-claim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'daemon.pid');
}

test('claimSingleInstance: fresh file → we own it (null, our pid written)', (t) => {
  const pidPath = tmp(t);
  const r = claimSingleInstance({ pidPath, pid: 1234, alive: () => true });
  assert.equal(r, null);
  assert.equal(readFileSync(pidPath, 'utf8'), '1234');
});

test('claimSingleInstance: a LIVE owner → step aside (returns owner pid, file untouched)', (t) => {
  const pidPath = tmp(t);
  writeFileSync(pidPath, '99999');
  const r = claimSingleInstance({ pidPath, pid: 1234, alive: (p) => p === 99999 });
  assert.equal(r, 99999);
  assert.equal(readFileSync(pidPath, 'utf8'), '99999');
});

test('claimSingleInstance: a DEAD owner is reclaimed (null, our pid wins)', (t) => {
  const pidPath = tmp(t);
  writeFileSync(pidPath, '99999');
  const r = claimSingleInstance({ pidPath, pid: 1234, alive: () => false });
  assert.equal(r, null);
  assert.equal(readFileSync(pidPath, 'utf8'), '1234');
});

test('claimSingleInstance: an empty / garbage pid file is reclaimed', (t) => {
  const pidPath = tmp(t);
  writeFileSync(pidPath, 'not-a-pid');
  const r = claimSingleInstance({ pidPath, pid: 1234, alive: () => true });
  assert.equal(r, null);
  assert.equal(readFileSync(pidPath, 'utf8'), '1234');
});

test('claimSingleInstance: our OWN recycled pid in the file is reclaimed, not mistaken for a peer', (t) => {
  const pidPath = tmp(t);
  writeFileSync(pidPath, '1234');
  const r = claimSingleInstance({ pidPath, pid: 1234, alive: () => true });
  assert.equal(r, null, 'owner === our pid cannot be a different live daemon → reclaim');
  assert.equal(readFileSync(pidPath, 'utf8'), '1234');
});
