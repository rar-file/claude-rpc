import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  fstatSync,
  readdirSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { STATE_PATH, STATE_DIR } from './paths.js';
import { pickActiveSession } from './presence.js';

const DEFAULT_STATE = {
  sessionStart: null,
  lastActivity: null,
  lastUserPrompt: null,
  lastNotification: null,
  status: 'idle',
  currentTool: null,
  currentFile: null,
  // Set by PreCompact, cleared by the next SessionStart (post-compaction
  // arrives as SessionStart with source:'compact', whose reset clears it).
  // While non-null the daemon renders the `compacting` frame so the card never
  // reads "thinking" during a context squeeze (distinct from reasoning).
  compactStartedAt: null,
  compactTrigger: null,
  // Set by PreToolUse, cleared by PostToolUse. format.js derives {toolElapsed}
  // from this when the working tool has been running long enough to be
  // worth surfacing (>5s by default — quick reads don't flicker on the card).
  toolStartedAt: null,
  // Set by PostToolUse when a `git push` or `git commit` is observed.
  // format.applyShipped promotes status to 'shipped' for shippedFrameSec
  // (default 60s) after this timestamp, so the card briefly celebrates
  // a ship instead of immediately returning to "Working in <project>".
  justShipped: null,
  justShippedKind: null,     // 'push' | 'commit'
  justShippedSubject: null,
  justShippedBranch: null,
  model: 'claude',
  cwd: process.cwd(),
  messages: 0,
  tools: 0,
  filesOpened: [],
  filesEdited: [],
  filesRead: [],
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  toolBreakdown: {},
  // Set true by the SessionEnd hook; cleared by any other hook event.
  // When true, the daemon goes stale instantly instead of waiting on the
  // staleSessionMin timeout — the cleanest "Claude is closed" signal we have.
  claudeClosed: false,
};

function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

// Claude Code fires lifecycle hooks in rapid bursts, and concurrent sessions /
// subagents mean several `claude-rpc hook` processes can run at once. Each does
// a read-modify-write of state.json; without a cross-process lock the last
// writer wins and the others' increments (messages, tools, tokens, file lists)
// are silently lost. The atomic tmp+rename in writeState only protects readers
// from torn files — it does nothing for lost updates. So updateState/resetState
// serialize through an exclusive lock file. The lock is strictly best-effort:
// if we can't get it within LOCK_MAX_WAIT_MS we proceed anyway (a slightly racy
// write is better than a dropped hook), and a stale lock from a crashed process
// is reclaimed after LOCK_STALE_MS. The lock path is per state file (passed in)
// so per-session writers don't serialize against each other.
const LOCK_STALE_MS = 2000;
const LOCK_RETRY_MS = 4;
const LOCK_MAX_WAIT_MS = 1000;

// Synchronous sleep — hooks are short-lived sync processes, so a blocking spin
// with a real wait (no busy-loop) is the right tool. Atomics.wait on a throwaway
// SharedArrayBuffer parks the thread without burning CPU.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* SharedArrayBuffer unavailable — fall through, caller just retries sooner */
  }
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      // 'wx' fails if the file exists — that's our mutex.
      return openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') return null; // unexpected (perms, etc.) — go lockless
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* someone else reclaimed it first */
          }
          continue;
        }
      } catch {
        /* lock vanished between open and stat — retry immediately */
      }
      if (Date.now() >= deadline) return null; // give up, proceed best-effort
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

function releaseLock(fd, lockPath) {
  if (fd === null) return;
  // Only unlink the lock if the path still points at OUR lock file. If this
  // process somehow held it past LOCK_STALE_MS, a sibling has reclaimed the
  // path (unlink + fresh 'wx' create); deleting that by path would collapse
  // mutual exclusion for a third writer. Inode equality proves ownership.
  let ours;
  try {
    const a = fstatSync(fd);
    const b = statSync(lockPath);
    ours = a.ino === b.ino && a.dev === b.dev;
  } catch {
    ours = false; // lock already gone — nothing to unlink
  }
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
  if (!ours) return;
  try {
    unlinkSync(lockPath);
  } catch {
    /* already removed */
  }
}

function withLock(lockPath, fn) {
  const fd = acquireLock(lockPath);
  try {
    return fn();
  } finally {
    releaseLock(fd, lockPath);
  }
}

// Resolve the state file for a session. No id → the legacy global state.json
// (single-session and back-compat). With an id → a per-session file, so
// concurrent sessions stop clobbering each other's status/tools/tokens and the
// daemon can pick which one to show. The id is a Claude Code session UUID;
// sanitize defensively for the filename regardless.
export function statePathFor(sessionId) {
  if (!sessionId) return STATE_PATH;
  const safe = String(sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'unknown';
  return join(STATE_DIR, `state-${safe}.json`);
}

export function readState(sessionId) {
  ensureDir();
  const path = statePathFor(sessionId);
  if (!existsSync(path)) return { ...DEFAULT_STATE };
  try {
    const raw = readFileSync(path, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

// The session a one-shot reader (status / serve / tui) should display. The
// daemon resolves per-session state with cross-tick stickiness; one-shot readers
// have no cursor, so they pass displayedId=null and get the most-recently-active
// session — exactly what the daemon settles on. Falls back to the legacy global
// state.json when no per-session files exist (e.g. a hook payload without an id).
export function readActiveState({ now = Date.now(), idleMs = 60_000 } = {}) {
  const sessions = listSessionStates();
  if (!sessions.length) return readState();
  return pickActiveSession(sessions, null, now, idleMs).state || readState();
}

export function writeState(next, sessionId) {
  ensureDir();
  const path = statePathFor(sessionId);
  // Per-process tmp name: two processes writing the same <path>.tmp would
  // clobber each other's tmp before rename. The pid suffix keeps the
  // atomic-rename guarantee intact even on the best-effort lockless path.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, path);
}

// Best-effort sweep of orphaned per-pid tmp files (`state.json.<pid>.tmp`) left
// behind when a writer was SIGKILLed between writeFileSync and renameSync —
// they never self-clean otherwise. Call once on daemon startup, NOT in
// ensureDir (the hot write path). 60s grace so we never race a live writer.
export function sweepStaleStateTmp(now = Date.now()) {
  try {
    const re = new RegExp(`^${basename(STATE_PATH).replace(/\./g, '\\.')}\\.\\d+\\.tmp$`);
    for (const name of readdirSync(STATE_DIR)) {
      if (!re.test(name)) continue;
      const full = join(STATE_DIR, name);
      try { if (now - statSync(full).mtimeMs > 60_000) unlinkSync(full); }
      catch { /* vanished or locked — best-effort */ }
    }
  } catch { /* STATE_DIR missing / unreadable — nothing to sweep */ }
}

// All per-session states currently on disk, each tagged with its sessionId
// (recovered from the `state-<id>.json` filename). The daemon uses this to pick
// which session to show. Excludes the legacy global state.json (no `-<id>`),
// and tmp/lock siblings (they don't end in `.json`).
export function listSessionStates() {
  ensureDir();
  const out = [];
  let names;
  try { names = readdirSync(STATE_DIR); } catch { return out; }
  for (const name of names) {
    const m = /^state-(.+)\.json$/.exec(name);
    if (!m) continue;
    try {
      const parsed = JSON.parse(readFileSync(join(STATE_DIR, name), 'utf8'));
      out.push({ ...DEFAULT_STATE, ...parsed, sessionId: m[1] });
    } catch { /* torn/broken file mid-write — skip this tick */ }
  }
  return out;
}

// Remove per-session state files whose last activity is older than maxAgeMs — a
// session that ended without cleanup, or a crashed one. Called periodically by
// the daemon; never touches the global state.json. Returns the count removed.
export function sweepStaleSessionStates(maxAgeMs = 6 * 60 * 60 * 1000, now = Date.now()) {
  let removed = 0, names;
  try { names = readdirSync(STATE_DIR); } catch { return 0; }
  for (const name of names) {
    if (!/^state-.+\.json$/.test(name)) continue;
    const full = join(STATE_DIR, name);
    try {
      const last = JSON.parse(readFileSync(full, 'utf8')).lastActivity || 0;
      if (now - last > maxAgeMs) { unlinkSync(full); removed++; }
    } catch {
      // Unparseable — age out by file mtime so a corrupt file still clears.
      try { if (now - statSync(full).mtimeMs > maxAgeMs) { unlinkSync(full); removed++; } }
      catch { /* gone */ }
    }
  }
  return removed;
}

export function updateState(mutator, sessionId) {
  const lockPath = statePathFor(sessionId) + '.lock';
  return withLock(lockPath, () => {
    const current = readState(sessionId);
    const next = mutator({ ...current }) ?? current;
    writeState(next, sessionId);
    return next;
  });
}

export function resetState(seed = {}, sessionId) {
  const lockPath = statePathFor(sessionId) + '.lock';
  return withLock(lockPath, () => {
    const fresh = { ...DEFAULT_STATE, sessionStart: Date.now(), lastActivity: Date.now(), ...seed };
    writeState(fresh, sessionId);
    return fresh;
  });
}

export function pushUnique(arr, value, max = 50) {
  if (!value) return arr;
  const filtered = arr.filter((v) => v !== value);
  filtered.unshift(value);
  return filtered.slice(0, max);
}

export function shortFile(path) {
  if (!path) return null;
  return basename(path);
}
