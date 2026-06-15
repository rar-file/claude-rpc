// Server-Sent Events: the dashboard pushes a one-line `data:` frame to
// connected browsers whenever state.json or aggregate.json is touched.
// Replaces the old 2-second poll. Two debounced fs.watch handles, one
// shared client set.

import { watch } from 'node:fs';
import { dirname, basename } from 'node:path';
import { STATE_PATH, AGGREGATE_PATH } from '../paths.js';

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

export function watchSources() {
  let stTimer = null, agTimer = null;
  watchFile(STATE_PATH, () => {
    clearTimeout(stTimer);
    stTimer = setTimeout(() => broadcast({ type: 'state' }), 200);
  });
  watchFile(AGGREGATE_PATH, () => {
    clearTimeout(agTimer);
    agTimer = setTimeout(() => broadcast({ type: 'aggregate' }), 200);
  });
}
