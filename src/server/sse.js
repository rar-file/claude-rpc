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
