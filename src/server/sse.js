// Server-Sent Events: the dashboard pushes a one-line `data:` frame to
// connected browsers whenever state.json or aggregate.json is touched.
// Replaces the old 2-second poll. Two debounced fs.watch handles, one
// shared client set.

import { watch } from 'node:fs';
import { STATE_PATH, AGGREGATE_PATH } from '../paths.js';

export const sseClients = new Set();

export function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}

export function watchSources() {
  let stTimer = null, agTimer = null;
  try {
    watch(STATE_PATH, () => {
      clearTimeout(stTimer);
      stTimer = setTimeout(() => broadcast({ type: 'state' }), 200);
    });
  } catch { /* state file not on disk yet — dashboard still works, just no SSE state events until daemon writes one */ }
  try {
    watch(AGGREGATE_PATH, () => {
      clearTimeout(agTimer);
      agTimer = setTimeout(() => broadcast({ type: 'aggregate' }), 200);
    });
  } catch { /* aggregate not on disk yet — dashboard renders empty stats until first scan completes */ }
}
