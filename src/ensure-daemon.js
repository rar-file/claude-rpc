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

import { spawn } from 'node:child_process';
import {
  openSync, closeSync, writeFileSync, readFileSync, unlinkSync, existsSync, statSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { PID_PATH, STATE_DIR, DAEMON_SCRIPT, CANONICAL_EXE, IS_PACKAGED } from './paths.js';

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

// The pid of the live daemon, or 0 if none is running.
export function daemonAlive(pidPath = PID_PATH) {
  const pid = readPid(pidPath);
  return pid && isAlive(pid) ? pid : 0;
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
export function shouldSpawnDaemon({ autostart, daemonPid, lastAttemptMs, now, cooldownMs }) {
  if (autostart === false) return false;                                  // explicit opt-out
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
  if (!shouldSpawnDaemon({ autostart, daemonPid: daemonAlive(), lastAttemptMs, now, cooldownMs })) return null;
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch { /* exists / unwritable */ }
  try { writeFileSync(SPAWN_MARKER, String(now)); } catch { /* best-effort cooldown */ }
  return spawnDaemonDetached();
}

// Atomic single-instance claim, called once by the daemon at startup. Returns
// the pid of an already-running daemon (caller should exit), or null when WE
// now own the pid file. The exclusive-create ('wx') makes the pid file itself
// the mutex: only one of N simultaneously-starting daemons can create it; the
// losers read the winner's live pid and step aside. A stale file (dead owner,
// empty, or our own recycled pid) is reclaimed and the create retried — so a
// crashed daemon never blocks its successor.
export function claimSingleInstance({ pidPath = PID_PATH, pid = process.pid, alive = isAlive } = {}) {
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
