// Regression tests for the SSE fs.watch stale-inode bug (issue #10).
// Both files tracked by watchSources() are updated via atomic rename
// (write-tmp + renameSync). On Linux, watch(filePath) binds to the inode
// present at call time — after the first rename that inode is replaced and
// the watcher fires once then goes permanently silent. watchFile() fixes
// this by watching the parent directory instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import { watchFile, sseClients, broadcast, addClient, removeClient } from '../src/server/sse.js';

test('watchFile survives repeated atomic renames (stale-inode regression)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sse-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const target = join(dir, 'state.json');
  const tmp1 = join(dir, 'state.json.1.tmp');
  const tmp2 = join(dir, 'state.json.2.tmp');

  // Write the initial file so the directory entry exists before we watch.
  writeFileSync(target, '{}');

  let calls = 0;
  const watcher = watchFile(target, () => { calls++; });
  t.after(() => watcher?.close());

  // First atomic rename — old watcher would survive this one but bind to dead inode.
  writeFileSync(tmp1, '{"a":1}');
  renameSync(tmp1, target);
  await delay(150);

  // Second atomic rename — before the fix the callback was never called again.
  writeFileSync(tmp2, '{"a":2}');
  renameSync(tmp2, target);
  await delay(150);

  assert.ok(calls >= 2, `expected callback ≥2 times (got ${calls}); watcher went silent after first rename`);
});

test('watchFile returns null when directory does not exist', () => {
  const watcher = watchFile('/nonexistent-dir-abc123/file.json', () => {});
  assert.equal(watcher, null);
});

test('broadcast reaps a client whose write throws; client set drains on remove', () => {
  sseClients.clear();
  const good = { lines: [], write(s) { this.lines.push(s); } };
  const dead = { write() { throw new Error('EPIPE'); } };
  addClient(good);
  addClient(dead);
  broadcast({ type: 'state' });
  assert.ok(good.lines.some((l) => l.includes('"state"')), 'live client received the frame');
  assert.ok(!sseClients.has(dead), 'dead socket evicted on write failure');
  removeClient(good);
  removeClient(dead);
  assert.equal(sseClients.size, 0, 'heartbeat stops when the last client leaves');
});
