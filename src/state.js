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
} from 'node:fs';
import { basename } from 'node:path';
import { STATE_PATH, STATE_DIR } from './paths.js';

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
// is reclaimed after LOCK_STALE_MS.
const LOCK_PATH = STATE_PATH + '.lock';
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

function acquireLock() {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      // 'wx' fails if the file exists — that's our mutex.
      return openSync(LOCK_PATH, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') return null; // unexpected (perms, etc.) — go lockless
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
          try {
            unlinkSync(LOCK_PATH);
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

function releaseLock(fd) {
  if (fd === null) return;
  // Only unlink the lock if the path still points at OUR lock file. If this
  // process somehow held it past LOCK_STALE_MS, a sibling has reclaimed the
  // path (unlink + fresh 'wx' create); deleting that by path would collapse
  // mutual exclusion for a third writer. Inode equality proves ownership.
  let ours;
  try {
    const a = fstatSync(fd);
    const b = statSync(LOCK_PATH);
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
    unlinkSync(LOCK_PATH);
  } catch {
    /* already removed */
  }
}

function withLock(fn) {
  const fd = acquireLock();
  try {
    return fn();
  } finally {
    releaseLock(fd);
  }
}

export function readState() {
  ensureDir();
  if (!existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
  try {
    const raw = readFileSync(STATE_PATH, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeState(next) {
  ensureDir();
  // Per-process tmp name: two processes writing the shared STATE_PATH + '.tmp'
  // would clobber each other's tmp before rename. The pid suffix keeps the
  // atomic-rename guarantee intact even on the best-effort lockless path.
  const tmp = `${STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, STATE_PATH);
}

export function updateState(mutator) {
  return withLock(() => {
    const current = readState();
    const next = mutator({ ...current }) ?? current;
    writeState(next);
    return next;
  });
}

export function resetState(seed = {}) {
  return withLock(() => {
    const fresh = { ...DEFAULT_STATE, sessionStart: Date.now(), lastActivity: Date.now(), ...seed };
    writeState(fresh);
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
