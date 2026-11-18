// ensure-daemon.js — the startup-assurance primitives: the hook's self-heal
// decision (shouldSpawnDaemon), the daemon's race-proof single-instance claim
// (claimSingleInstance), and the liveness probe (isAlive). spawnDaemonDetached /
// ensureDaemonRunning launch a real detached process, so they're exercised
// end-to-end elsewhere; here we cover the pure logic + the fs-level claim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// doctor.js and tui.js used to carry their own probe that read EPERM ("exists,
// but you may not signal it") as dead: doctor reported a running daemon as a
// stale pid file, the TUI as not running. Both now use isAlive. Run them in a
// child with a sandboxed HOME/TMPDIR so the real pid file is never touched.
test('doctor + tui treat an EPERM pid as running (shared isAlive)', (t) => {
  const box = mkdtempSync(join(tmpdir(), 'rpc-eperm-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const src = (m) => JSON.stringify(pathToFileURL(join(REPO, 'src', m)).href);
  const script = `
    const FAKE = 424242;
    const realKill = process.kill.bind(process);
    process.kill = (pid, sig) => {
      if (pid === FAKE) { const e = new Error('kill EPERM'); e.code = 'EPERM'; throw e; }
      return realKill(pid, sig);
    };
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const paths = await import(${src('paths.js')});
    mkdirSync(paths.STATE_DIR, { recursive: true });
    writeFileSync(paths.PID_PATH, String(FAKE));
    const tui = await import(${src('tui.js')});
    console.log('TUI_PID=' + tui.loadSnapshot().pid);
    const { runDoctor } = await import(${src('doctor.js')});
    runDoctor();
  `;
  const env = {
    ...process.env, HOME: box, USERPROFILE: box, XDG_CONFIG_HOME: join(box, '.config'),
    TMPDIR: join(box, 'tmp'), TMP: join(box, 'tmp'), TEMP: join(box, 'tmp'),
    CLAUDE_RPC_NO_AUTOSTART: '1', NO_COLOR: '1',
  };
  mkdirSync(env.TMPDIR, { recursive: true });
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 30_000 });
  assert.match(r.stdout, /TUI_PID=424242/, `tui pid\n${r.stdout}\n${r.stderr}`);
  const line = r.stdout.split('\n').find((l) => l.includes('daemon running')) || '';
  assert.match(line, /pid 424242/, `doctor line: ${line}`);
  assert.doesNotMatch(line, /stale/);
});

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

// ── stop intent, heartbeat liveness, stale-daemon replacement (1.9.0) ────
const {
  pidIsDaemon, shouldReplaceDaemon, isNewerVersion, markStopped, clearStopped, isStopped,
  stopDaemonAndWait, readDaemonInfo, writeDaemonInfo,
} = await import('../src/ensure-daemon.js');

test('shouldSpawnDaemon: a `stop` sticks — the hook never respawns a stopped daemon', () => {
  assert.equal(shouldSpawnDaemon({ autostart: true, stopped: true, daemonPid: 0, lastAttemptMs: 0, now: NOW, cooldownMs: COOL }), false);
});

test('stop marker: mark → isStopped, clear → not', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crpc-stop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, 'sub', 'stopped');
  assert.equal(isStopped(p), false);
  assert.equal(markStopped(p), true);
  assert.equal(isStopped(p), true);
  clearStopped(p);
  assert.equal(isStopped(p), false);
  clearStopped(p); // idempotent
});

test('pidIsDaemon: a live pid with a stale heartbeat is a recycled pid, not our daemon', () => {
  const alive = () => true;
  const now = 10_000_000;
  assert.equal(pidIsDaemon(42, { alive, now, info: { pid: 42, beatAt: now - 10_000 } }), true);
  assert.equal(pidIsDaemon(42, { alive, now, info: { pid: 42, beatAt: now - 6 * 60_000 } }), false);
  // No heartbeat for THIS pid (pre-1.9 daemon, or the file names another pid): bare probe.
  assert.equal(pidIsDaemon(42, { alive, now, info: null }), true);
  assert.equal(pidIsDaemon(42, { alive, now, info: { pid: 7, beatAt: 0 } }), true);
  assert.equal(pidIsDaemon(42, { alive: () => false, now, info: null }), false);
  assert.equal(pidIsDaemon(0, { alive, now }), false);
});

test('shouldReplaceDaemon: replace an older or version-less daemon, never a same/newer one', () => {
  assert.equal(shouldReplaceDaemon({ info: { pid: 5, version: '1.8.0' }, pid: 5, version: '1.9.0' }), true);
  assert.equal(shouldReplaceDaemon({ info: { pid: 5, version: '1.9.0' }, pid: 5, version: '1.9.0' }), false);
  assert.equal(shouldReplaceDaemon({ info: { pid: 5, version: '1.9.1' }, pid: 5, version: '1.9.0' }), false);
  // pre-1.9 daemons write no info: replace, but at most once per cooldown
  assert.equal(shouldReplaceDaemon({ info: null, pid: 5, version: '1.9.0', lastAttemptMs: 0, now: NOW }), true);
  assert.equal(shouldReplaceDaemon({ info: null, pid: 5, version: '1.9.0', lastAttemptMs: NOW - 60_000, now: NOW }), false);
  assert.equal(shouldReplaceDaemon({ info: null, pid: 5, version: '1.9.0', lastAttemptMs: NOW - 31 * 60_000, now: NOW }), true);
});

test('isNewerVersion: numeric semver compare', () => {
  assert.equal(isNewerVersion('1.10.0', '1.9.9'), true);
  assert.equal(isNewerVersion('1.9.0', '1.9.0'), false);
  assert.equal(isNewerVersion('1.8.9', '1.9.0'), false);
  assert.equal(isNewerVersion('junk', '1.9.0'), false);
});

test('daemon info round-trips through an atomic write', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crpc-info-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, 'daemon.json');
  assert.equal(readDaemonInfo(p), null);
  writeDaemonInfo({ pid: 9, version: '1.9.0', beatAt: 1 }, p);
  assert.deepEqual(readDaemonInfo(p), { pid: 9, version: '1.9.0', beatAt: 1 });
  writeFileSync(p, '{"half":');
  assert.equal(readDaemonInfo(p), null, 'a torn read is "no info", never a throw');
});

test('stopDaemonAndWait: waits for a real exit and removes the dead daemon\'s pid file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crpc-stopwait-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }); // warm
  assert.equal(child.status, 0);
  const { spawn } = await import('node:child_process');
  // A child that ignores SIGTERM, so the SIGKILL fallback is exercised too.
  const victim = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  const pidPath = join(dir, 'daemon.pid');
  writeFileSync(pidPath, String(victim.pid));
  const ok = await stopDaemonAndWait({ pidPath, infoPath: join(dir, 'none.json'), graceMs: 300, killMs: 2000 });
  assert.equal(ok, true);
  assert.equal(isAlive(victim.pid), false);
  assert.throws(() => readFileSync(pidPath), /ENOENT/, 'pid file of the killed daemon is gone');
});

test('stopDaemonAndWait: nothing running → true, and a stale pid file is cleaned up', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'crpc-stopnone-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pidPath = join(dir, 'daemon.pid');
  writeFileSync(pidPath, '2000000000');
  assert.equal(await stopDaemonAndWait({ pidPath, infoPath: join(dir, 'none.json') }), true);
  assert.throws(() => readFileSync(pidPath), /ENOENT/);
});
