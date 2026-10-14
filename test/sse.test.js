// Regression tests for the SSE fs.watch stale-inode bug (issue #10).
// Both files tracked by watchSources() are updated via atomic rename
// (write-tmp + renameSync). On Linux, watch(filePath) binds to the inode
// present at call time — after the first rename that inode is replaced and
// the watcher fires once then goes permanently silent. watchFile() fixes
// this by watching the parent directory instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

import {
  watchFile, watchSources, newestMtime, STATE_FILE_RE,
  sseClients, broadcast, addClient, removeClient,
} from '../src/server/sse.js';

async function waitFor(pred, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await delay(20);
  }
  return pred();
}

// state.js's writer: per-pid tmp file, then rename over the target.
function atomicWrite(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(`${p}.${process.pid}.tmp`, body);
  renameSync(`${p}.${process.pid}.tmp`, p);
}

test('watchFile survives repeated atomic renames (stale-inode regression)', async (t) => {
  // This exercises raw fs.watch, not the mtime-poll fallback (see
  // watch-poll.js) — and fs.watch on Windows is documented to drop events
  // from an atomic rename, which is the exact scenario here. That's not a
  // regression to catch, it's the known gap the poll fallback exists to
  // cover; asserting on the raw watcher's behavior would just be flaky.
  if (process.platform === 'win32') return t.skip('fs.watch drops rename events on Windows — poll fallback covers this, see watch-poll.test.js');
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

// Hooks write state-<sid>.json (src/state.js statePathFor), not state.json —
// the SSE layer only matched the legacy name, so hook events never reached
// the dashboard's live rail.
test('STATE_FILE_RE matches the whole state family, not tmp/lock siblings', () => {
  for (const ok of ['state.json', 'state-abc123.json', 'state-6f1c0b9e-2d4a-4c1e-9f00-7d2b1a3c4e5f.json']) {
    assert.ok(STATE_FILE_RE.test(ok), ok);
  }
  for (const no of ['state-abc.json.4242.tmp', 'state-abc.json.lock', 'state.json.lock', 'pause.json', 'xstate.json', 'state-.json.bak']) {
    assert.ok(!STATE_FILE_RE.test(no), no);
  }
});

test('newestMtime is the max across matching files only (poll fallback sees every session)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sse-mtime-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name, sec) => { writeFileSync(join(dir, name), '{}'); utimesSync(join(dir, name), sec, sec); };
  put('state-a.json', 1_000);
  put('state-b.json', 2_000);
  put('state-b.json.77.tmp', 9_000);
  put('pause.json', 9_000);
  const isState = (f) => STATE_FILE_RE.test(f);
  assert.equal(newestMtime(dir, isState), 2_000_000);
  assert.equal(newestMtime(dir, (f) => f === 'nope.json'), undefined, 'no match → undefined');
  assert.equal(newestMtime(join(dir, 'missing'), isState), undefined, 'missing dir → undefined');
});

test('watchSources broadcasts on per-session state writes and aggregate writes', async (t) => {
  // Raw fs.watch drops atomic-rename events on Windows (see the first test);
  // the poll fallback covers that platform.
  if (process.platform === 'win32') return t.skip('fs.watch drops rename events on Windows — poll fallback covers this');
  const root = mkdtempSync(join(tmpdir(), 'sse-sources-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const dataDir = join(root, 'data');
  mkdirSync(stateDir);
  mkdirSync(dataDir);

  const frames = [];
  const client = { write: (s) => { if (s.startsWith('data:')) frames.push(JSON.parse(s.slice(5)).type); } };
  sseClients.clear();
  addClient(client);
  t.after(() => removeClient(client));
  const handle = watchSources({ stateDir, aggregatePath: join(dataDir, 'aggregate.json'), pollMs: 60_000, debounceMs: 20 });
  t.after(() => handle.close());

  atomicWrite(stateDir, 'state-abc123.json', '{"status":"working"}');
  assert.ok(await waitFor(() => frames.includes('state')), 'per-session state write → state frame');

  frames.length = 0;
  atomicWrite(stateDir, 'state.json', '{"status":"idle"}');
  assert.ok(await waitFor(() => frames.includes('state')), 'legacy state.json still counts');

  frames.length = 0;
  atomicWrite(dataDir, 'aggregate.json', '{}');
  assert.ok(await waitFor(() => frames.includes('aggregate')), 'aggregate write → aggregate frame');

  await delay(100);
  frames.length = 0;
  writeFileSync(join(stateDir, 'state-abc123.json.lock'), '');
  writeFileSync(join(stateDir, 'pause.json'), '{}');
  await delay(250);
  assert.deepEqual(frames, [], 'lock files and unrelated files do not broadcast');
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
