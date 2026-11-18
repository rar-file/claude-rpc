// Daemon-lifecycle primitives shared by the CLI (`start`), the daemon itself
// (single-instance guard), and the hook (self-heal on SessionStart). Kept in a
// tiny dependency-light module so the hook — which runs on every Claude Code
// event and must stay fast and crash-proof — can import the spawn recipe
// without pulling in cli.js's UI stack.
//
// The "ultra assured startup" story lives here: the daemon comes up whenever a
// Claude Code session starts (ensureDaemonRunning, called from the hook), and a
// race-proof claim (claimSingleInstance, called by the daemon) guarantees that
// no matter how many launchers fire at once — a manual `start`, a Windows Run
// entry, several SessionStart hooks from concurrent sessions — exactly one
// daemon survives.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  PID_PATH, STATE_DIR, DAEMON_SCRIPT, CANONICAL_EXE, IS_PACKAGED, DAEMON_INFO_PATH, STOPPED_PATH,
} from './paths.js';
import { renameSyncRetry, sleepSync } from './atomic-rename.js';
import { VERSION } from './version.js';

// require()d, not imported — on the hook hot path; see hook.js.
const require = createRequire(import.meta.url);
const {
  openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, statSync, mkdirSync,
} = require('node:fs');

// The daemon rewrites its heartbeat (DAEMON_INFO_PATH.beatAt) this often (its
// lifecycle watchdog tick); a
// beat older than BEAT_STALE_MS means the pid in the pid file is not our daemon
// any more (it died without cleanup and the OS recycled the pid — common after a
// Windows/macOS reboot, where the tmp dir and its stale pid file survive) or the
// daemon is wedged. Generous on purpose: a laptop waking from sleep shows a stale
// beat for up to one interval, and the cost of a false "dead" is one duplicate
// spawn that the daemons' own pid-file check reaps within a watchdog tick.
export const BEAT_EVERY_MS = 30_000;
export const BEAT_STALE_MS = 5 * 60_000;

// mtime of this marker = last time any launcher attempted a spawn. A short
// cooldown stops concurrent SessionStart hooks (several sessions opening at
// once) and any startup crash-loop from spawning a swarm of throwaway daemons —
// the single-instance claim would reap them, but not spawning them is cheaper.
const SPAWN_MARKER = join(STATE_DIR, 'daemon-spawn.ts');
const SPAWN_COOLDOWN_MS = 15_000;

// True if `pid` names a live process. process.kill(pid,0) sends no signal — it
// just probes: ESRCH → gone, EPERM → exists but owned by someone else (still
// alive). 0/NaN is never alive.
export function isAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

export function readPid(pidPath = PID_PATH) {
  try { return Number(readFileSync(pidPath, 'utf8')) || 0; }
  catch { return 0; }
}

// { pid, version, startedAt, beatAt } written by daemons from 1.9.0 on, or null
// (missing, unreadable, or an older daemon that never wrote one).
export function readDaemonInfo(infoPath = DAEMON_INFO_PATH) {
  try {
    const j = JSON.parse(readFileSync(infoPath, 'utf8'));
    return j && typeof j === 'object' && Number.isFinite(j.pid) ? j : null;
  } catch { return null; }
}

export function writeDaemonInfo(info, infoPath = DAEMON_INFO_PATH) {
  try {
    mkdirSync(dirname(infoPath), { recursive: true });
    const tmp = `${infoPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(info));
    renameSyncRetry(tmp, infoPath);
  } catch { /* advisory — liveness falls back to the bare pid probe */ }
}

// Pure: is `pid` our live daemon? A live pid is only trusted when the heartbeat
// written for THAT pid is fresh; with no heartbeat for it (a pre-1.9 daemon, or
// the info file belongs to someone else) the bare probe is all we have.
export function pidIsDaemon(pid, { info = null, alive = isAlive, now = Date.now(), staleMs = BEAT_STALE_MS } = {}) {
  if (!pid || !alive(pid)) return false;
  if (info && info.pid === pid && Number.isFinite(info.beatAt) && now - info.beatAt > staleMs) return false;
  return true;
}

// The pid of the live daemon, or 0 if none is running.
export function daemonAlive(pidPath = PID_PATH, infoPath = DAEMON_INFO_PATH) {
  const pid = readPid(pidPath);
  return pidIsDaemon(pid, { info: pid ? readDaemonInfo(infoPath) : null }) ? pid : 0;
}

// ── stop intent ──────────────────────────────────────────────────────────
// `stop` used to send one signal and record nothing, so the very next
// SessionStart hook (any new session, /clear, a `claude -p` run) spawned the
// daemon right back. The marker makes a stop stick: the hook, the login
// autostart (the daemon checks it at boot) and running daemons (their watchdog
// checks it) all honor it until start/restart/setup clears it.
export function isStopped(path = STOPPED_PATH) {
  return existsSync(path);
}
export function markStopped(path = STOPPED_PATH) {
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, String(Date.now())); return true; }
  catch { return false; }
}
export function clearStopped(path = STOPPED_PATH) {
  try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
}

// Stop the daemon and wait until it is really gone. SIGTERM, then SIGKILL if it
// ignored that for `graceMs` (on Windows process.kill is always a hard kill).
// A hard kill skips the daemon's own cleanup, so a pid file still naming the
// dead pid is removed here — otherwise a recycled pid reads as "running".
// Resolves true when no daemon is left. `kill`/`sleep` are injectable for tests.
export async function stopDaemonAndWait({
  pidPath = PID_PATH, infoPath = DAEMON_INFO_PATH, graceMs = 3000, killMs = 1500,
  kill = (pid, sig) => process.kill(pid, sig), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const pid = daemonAlive(pidPath, infoPath);
  if (!pid) { cleanupPidFile(0, pidPath); return true; }
  const gone = async (ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (!isAlive(pid)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(50);
    }
  };
  try { kill(pid, 'SIGTERM'); } catch { /* already gone / not ours */ }
  let ok = await gone(graceMs);
  if (!ok) {
    try { kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    ok = await gone(killMs);
  }
  if (ok) cleanupPidFile(pid, pidPath);
  return ok;
}

// Remove the pid file if it still names `pid` (or a dead process when pid=0).
function cleanupPidFile(pid, pidPath = PID_PATH) {
  try {
    const cur = readPid(pidPath);
    if (cur && (cur === pid || (!pid && !isAlive(cur)))) unlinkSync(pidPath);
  } catch { /* gone already */ }
}

// The single source of truth for HOW to launch the daemon, shared by every
// launcher so the CLI and the hook spawn it identically:
//   packaged → "<canonical exe>" daemon   (prefer the canonical install over a
//              transient Downloads copy so we don't keep that file locked open)
//   dev/npm  → "<node>" "<abs daemon.js>" (PATH-independent — process.execPath
//              is the very node already running us)
// Always detached + windowless + stdio-ignored so it outlives the launcher and
// never pops a console. Returns the child (caller reads .pid) or null on a
// synchronous spawn failure.
export function spawnDaemonDetached() {
  const exe = (IS_PACKAGED && existsSync(CANONICAL_EXE)) ? CANONICAL_EXE : process.execPath;
  const args = IS_PACKAGED ? ['daemon'] : [DAEMON_SCRIPT];
  try {
    // Required here, not imported: node:child_process (plus dgram and the
    // spawn bindings it pulls in) costs the hook a few ms on every event,
    // although it only spawns when the daemon is down.
    const { spawn } = require('node:child_process');
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
    // An async spawn failure (ENOENT on the exe) emits 'error'; with no listener
    // Node rethrows it as an unhandled exception that can take down the launcher.
    // Swallow — the caller verifies liveness via the pid file, not the child.
    child.on('error', () => {});
    child.unref();
    return child;
  } catch {
    return null;
  }
}

// Pure decision for the hook's self-heal: should THIS SessionStart spawn a
// daemon? Separated from the side effects so it's unit-testable.
export function shouldSpawnDaemon({ autostart, stopped = false, daemonPid, lastAttemptMs, now, cooldownMs }) {
  if (autostart === false) return false;                                  // explicit opt-out
  if (stopped) return false;                                              // `claude-rpc stop` sticks
  if (daemonPid) return false;                                            // already running
  if (lastAttemptMs && now - lastAttemptMs < cooldownMs) return false;    // within the cooldown
  return true;
}

// Self-heal entry point, called by the SessionStart hook. Best-effort and fast:
// if no daemon is running (reboot, crash, OS sleep, closed terminal — or simply
// a platform with no login-autostart entry), bring one up. Stamps the cooldown
// marker BEFORE spawning so sibling SessionStart hooks racing this one skip
// instead of each launching a throwaway. Returns the spawned child, or null.
export function ensureDaemonRunning({ autostart = true, now = Date.now(), cooldownMs = SPAWN_COOLDOWN_MS } = {}) {
  let lastAttemptMs = 0;
  try { if (existsSync(SPAWN_MARKER)) lastAttemptMs = statSync(SPAWN_MARKER).mtimeMs; } catch { /* unreadable — treat as never */ }
  const stopped = isStopped();
  let daemonPid = daemonAlive();
  // An update swaps the files on disk but the running daemon keeps executing
  // the old code — forever, since nothing restarted it (`npm i -g`, the
  // desktop app's updater, a re-downloaded exe). The hook is the newer code, so
  // it replaces a daemon that is older than itself (or too old to say).
  if (daemonPid && autostart !== false && !stopped
      && shouldReplaceDaemon({ info: readDaemonInfo(), pid: daemonPid, version: VERSION, lastAttemptMs, now })) {
    stampSpawn(now);
    if (!replaceDaemonSync(daemonPid)) return null;
    daemonPid = 0;
    lastAttemptMs = 0;
  }
  if (!shouldSpawnDaemon({ autostart, stopped, daemonPid, lastAttemptMs, now, cooldownMs })) return null;
  stampSpawn(now);
  return spawnDaemonDetached();
}

function stampSpawn(now) {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* exists / unwritable */ }
  try { writeFileSync(SPAWN_MARKER, String(now)); } catch { /* best-effort cooldown */ }
}

// Pure: should a launcher at `version` replace the running daemon? Yes when the
// daemon reports an older version, or reports nothing (pre-1.9 daemons never
// wrote daemon.json). The no-info case is rate-limited to one attempt per
// REPLACE_COOLDOWN_MS so an unwritable tmp dir can't restart it every session.
const REPLACE_COOLDOWN_MS = 30 * 60_000;
export function shouldReplaceDaemon({ info, pid, version, lastAttemptMs = 0, now = Date.now(), cooldownMs = REPLACE_COOLDOWN_MS }) {
  if (info && info.pid === pid) return typeof info.version === 'string' && isNewerVersion(version, info.version);
  return !(lastAttemptMs && now - lastAttemptMs < cooldownMs);
}

export function isNewerVersion(a, b) {
  const p = (v) => (/^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '')) || []).slice(1).map(Number);
  const x = p(a), y = p(b);
  if (x.length !== 3 || y.length !== 3) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Synchronous stop for the hook (it can't await): SIGTERM, wait ≤2s for the
// process to go, hard-kill if it didn't. True once it's gone.
function replaceDaemonSync(pid) {
  const waitGone = (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (!isAlive(pid)) return true; sleepSync(50); }
    return !isAlive(pid);
  };
  try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  let gone = waitGone(2000);
  if (!gone) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } gone = waitGone(1000); }
  if (gone) cleanupPidFile(pid);
  return gone;
}

// Atomic single-instance claim, called once by the daemon at startup. Returns
// the pid of an already-running daemon (caller should exit), or null when WE
// now own the pid file. The exclusive-create ('wx') makes the pid file itself
// the mutex: only one of N simultaneously-starting daemons can create it; the
// losers read the winner's live pid and step aside. A stale file (dead owner,
// empty, or our own recycled pid) is reclaimed and the create retried — so a
// crashed daemon never blocks its successor.
export function claimSingleInstance({ pidPath = PID_PATH, pid = process.pid, alive = (p) => pidIsDaemon(p, { info: readDaemonInfo() }) } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let fd;
    try {
      fd = openSync(pidPath, 'wx'); // atomic: throws EEXIST if the file already exists
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Unexpected (perms, missing dir). Best-effort write and take ownership
        // rather than refusing to start.
        try { writeFileSync(pidPath, String(pid)); } catch { /* unwritable — run lockless */ }
        return null;
      }
      let owner = 0;
      try { owner = Number(readFileSync(pidPath, 'utf8')) || 0; } catch { /* mid-write — reclaim */ }
      if (owner && owner !== pid && alive(owner)) return owner; // a live daemon already owns it
      try { unlinkSync(pidPath); } catch { /* a racer reclaimed it first */ }
      continue; // retry the exclusive create
    }
    try { writeFileSync(fd, String(pid)); } finally { try { closeSync(fd); } catch { /* already closed */ } }
    return null; // we created the file → we are THE daemon
  }
  // Repeatedly lost the reclaim race (extreme contention) — proceed best-effort.
  try { writeFileSync(pidPath, String(pid)); } catch { /* unwritable */ }
  return null;
}
