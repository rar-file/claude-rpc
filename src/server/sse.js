// Server-Sent Events: the dashboard pushes a one-line `data:` frame to
// connected browsers whenever state.json or aggregate.json is touched.
// Replaces the old 2-second poll. Two debounced fs.watch handles, one
// shared client set.

import { watch, existsSync, statSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { STATE_PATH, AGGREGATE_PATH } from '../paths.js';
import { pollDecision, pollIntervalMs } from '../watch-poll.js';

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

// Watch a file that is updated via atomic rename (write-tmp + renameSync).
// Watching the file path directly binds to the inode at watch-time — on
// Linux that inode is replaced by the first rename, so the watcher fires
// once then goes permanently silent. Watching the parent directory avoids
// this: directory inodes are stable across entry renames.
export function watchFile(filePath, callback) {
  const dir = dirname(filePath);
  const name = basename(filePath);
  try {
    return watch(dir, (_, filename) => {
      if (!filename || filename === name) callback();
    });
  } catch {
    return null;
  }
}

function statMtime(filePath) {
  try {
    return existsSync(filePath) ? statSync(filePath).mtimeMs : undefined;
  } catch {
    return undefined; // mid-rename; a later observation records it
  }
}

export function watchSources() {
  const targets = [
    { path: STATE_PATH, type: 'state' },
    { path: AGGREGATE_PATH, type: 'aggregate' },
  ];

  // Last mtime we've reacted to, per target. Updated by BOTH the watcher and
  // the poll fallback below, so a change one path already handled resolves
  // to a no-op for the other instead of a duplicate broadcast — same shared-
  // baseline trick the daemon's own watchFiles() uses.
  const lastMtime = new Map();
  const debounceTimers = new Map();
  const recordMtime = (t) => {
    const m = statMtime(t.path);
    if (m !== undefined) lastMtime.set(t.path, m);
  };
  targets.forEach(recordMtime); // seed baselines before watching starts

  const fire = (t) => {
    recordMtime(t); // record before the debounced broadcast so a re-entrant tick can't double-fire
    clearTimeout(debounceTimers.get(t.path));
    debounceTimers.set(t.path, setTimeout(() => broadcast({ type: t.type }), 200));
  };

  for (const t of targets) watchFile(t.path, () => fire(t));

  // Mtime-poll fallback. fs.watch drops atomic-rename events on Windows (see
  // watch-poll.js), and unlike the daemon this watcher previously had no
  // backstop at all — a missed event left the dashboard silently stale until
  // some unrelated broadcast happened to fire. Same cadence as the daemon's
  // fallback: fast on Windows, lazy on macOS/Linux.
  setInterval(() => {
    for (const t of targets) {
      const cur = statMtime(t.path);
      const decision = pollDecision(lastMtime.get(t.path), cur);
      if (decision === 'seed') lastMtime.set(t.path, cur);
      else if (decision === 'fire') fire(t);
    }
  }, pollIntervalMs());
}
