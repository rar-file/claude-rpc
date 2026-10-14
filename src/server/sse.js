// Server-Sent Events: the dashboard pushes a one-line `data:` frame to
// connected browsers whenever a session state file or aggregate.json is
// touched. Replaces the old 2-second poll. One debounced directory watcher
// per source plus an mtime-poll fallback, one shared client set.

import { watch, readdirSync, statSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { STATE_DIR, AGGREGATE_PATH } from '../paths.js';
import { pollDecision, pollIntervalMs } from '../watch-poll.js';

// Hooks write one state-<sid>.json per Claude Code session (src/state.js
// statePathFor); the legacy global state.json is only written for payloads
// without a session id. Watch the whole family, same filter as the daemon's
// watchFiles() — matching only the literal 'state.json' meant real hook events
// never reached the live rail. Write-tmp (`*.json.<pid>.tmp`) and lock
// (`*.json.lock`) siblings don't end in `.json`, so they don't match.
export const STATE_FILE_RE = /^state(-.+)?\.json$/;

export const sseClients = new Set();

export function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}

// Heartbeat: bytes only flow on file-change broadcasts, so an idle connection
// can sit half-open indefinitely and a dead socket isn't reaped until the next
// real write throws. A periodic comment frame keeps connections warm and lets
// the write/try-catch evict peers that have gone away. Started on the first
// client, cleared when the last one leaves.
const HEARTBEAT_MS = 20_000;
let heartbeat = null;

export function addClient(res) {
  sseClients.add(res);
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const r of sseClients) {
      try { r.write(': ping\n\n'); } catch { sseClients.delete(r); }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref?.(); // a lone heartbeat shouldn't keep the process alive
}

export function removeClient(res) {
  sseClients.delete(res);
  if (sseClients.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

// Watch a directory for entries whose name passes `matches`. Every writer here
// commits via atomic rename (write-tmp + renameSync), and watching a file path
// directly binds to the inode at watch-time — on Linux that inode is replaced
// by the first rename, so the watcher fires once then goes permanently silent.
// Directory inodes are stable across entry renames. A null filename (some
// platforms) is treated as a match. `onError` runs if the watcher dies (e.g.
// the directory was removed) so the caller can re-attach later.
export function watchDir(dir, matches, callback, onError) {
  try {
    const w = watch(dir, (_, filename) => {
      if (!filename || matches(String(filename))) callback();
    });
    w.on('error', () => {
      try { w.close(); } catch { /* already closed */ }
      onError?.();
    });
    return w;
  } catch {
    return null;
  }
}

// Single-file convenience wrapper over watchDir (watches the parent directory).
export function watchFile(filePath, callback) {
  const name = basename(filePath);
  return watchDir(dirname(filePath), (f) => f === name, callback);
}

// Newest mtime among the entries of `dir` that pass `matches` (undefined when
// none exist or the directory is missing). For the state family this is the
// max across every session file — monotone under writes, so the poll's
// `cur > prev` test still detects a change in ANY session; a deleted session
// file lowers it, which correctly doesn't fire.
export function newestMtime(dir, matches) {
  let max;
  let names;
  try { names = readdirSync(dir); } catch { return undefined; }
  for (const name of names) {
    if (!matches(name)) continue;
    try {
      const m = statSync(join(dir, name)).mtimeMs;
      if (max === undefined || m > max) max = m;
    } catch { /* vanished or mid-rename; a later observation records it */ }
  }
  return max;
}

// Start the watchers + poll fallback. Paths are injectable for tests; the
// server calls it with the defaults. Returns { close } to stop everything.
export function watchSources({
  stateDir = STATE_DIR,
  aggregatePath = AGGREGATE_PATH,
  pollMs = pollIntervalMs(),
  debounceMs = 200,
} = {}) {
  const aggName = basename(aggregatePath);
  const targets = [
    { type: 'state', dir: stateDir, matches: (f) => STATE_FILE_RE.test(f), watcher: null },
    { type: 'aggregate', dir: dirname(aggregatePath), matches: (f) => f === aggName, watcher: null },
  ];

  // Last mtime we've reacted to, per target. Updated by BOTH the watcher and
  // the poll fallback below, so a change one path already handled resolves
  // to a no-op for the other instead of a duplicate broadcast — same shared-
  // baseline trick the daemon's own watchFiles() uses.
  const lastMtime = new Map();
  const debounceTimers = new Map();
  const recordMtime = (t) => {
    const m = newestMtime(t.dir, t.matches);
    if (m !== undefined) lastMtime.set(t.type, m);
  };
  targets.forEach(recordMtime); // seed baselines before watching starts

  const fire = (t) => {
    recordMtime(t); // record before the debounced broadcast so a re-entrant tick can't double-fire
    clearTimeout(debounceTimers.get(t.type));
    debounceTimers.set(t.type, setTimeout(() => broadcast({ type: t.type }), debounceMs));
  };

  // A directory that doesn't exist yet (fresh install, no hook has run) can't
  // be watched; the poll tick below retries the attachment.
  const attach = (t) => {
    if (t.watcher) return;
    t.watcher = watchDir(t.dir, t.matches, () => fire(t), () => { t.watcher = null; });
  };
  targets.forEach(attach);

  // Mtime-poll fallback. fs.watch drops atomic-rename events on Windows (see
  // watch-poll.js), and unlike the daemon this watcher previously had no
  // backstop at all — a missed event left the dashboard silently stale until
  // some unrelated broadcast happened to fire. Same cadence as the daemon's
  // fallback: fast on Windows, lazy on macOS/Linux.
  const poll = setInterval(() => {
    for (const t of targets) {
      attach(t);
      const cur = newestMtime(t.dir, t.matches);
      const decision = pollDecision(lastMtime.get(t.type), cur);
      if (decision === 'seed') lastMtime.set(t.type, cur);
      else if (decision === 'fire') fire(t);
    }
  }, pollMs);

  return {
    close() {
      clearInterval(poll);
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      for (const t of targets) {
        try { t.watcher?.close(); } catch { /* already closed */ }
        t.watcher = null;
      }
    },
  };
}
