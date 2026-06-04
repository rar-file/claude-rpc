// Coverage for src/community.js — the opt-in telemetry client. We
// exercise the pure helpers (buildPayload, osFamily, cursor I/O) and the
// flushCommunity branches using an injected fetch impl and temp paths
// for both the aggregate and the cursor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { buildPayload, osFamily, readCursor, writeCursor, flushCommunity,
  buildProfilePayload, flushProfile } =
  await import('../src/community.js');

const VALID_ID = '12345678-1234-4abc-abcd-1234567890ab';

function makeTempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-community-'));
  return {
    dir,
    aggregatePath: join(dir, 'aggregate.json'),
    cursorPath: join(dir, 'cursor.json'),
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function fakeFetch({ status = 200, body = '{"ok":true}' } = {}, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() { return body; },
      async json() { return JSON.parse(body); },
    };
  };
}

// ── pure helpers ───────────────────────────────────────────────────────

test('osFamily: returns one of the canonical three', () => {
  assert.match(osFamily(), /^(linux|darwin|win32)$/);
});

test('buildPayload: computes deltas from aggregate vs cursor', () => {
  const agg = { sessions: 10, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100 };
  const cur = { sessions: 4, tokens: 1200 };
  const p = buildPayload(agg, cur, { instanceId: VALID_ID, now: 1_000 });
  assert.equal(p.sessionsDelta, 6, '10 - 4');
  assert.equal(p.tokensDelta, 600, '(1000+500+200+100) - 1200');
  assert.equal(p.instanceId, VALID_ID);
  assert.equal(p.ts, 1_000);
});

test('buildPayload: clamps negative deltas to zero (cursor newer than aggregate)', () => {
  const agg = { sessions: 1, inputTokens: 0, outputTokens: 0 };
  const cur = { sessions: 100, tokens: 999_999 };
  const p = buildPayload(agg, cur, { instanceId: VALID_ID });
  assert.equal(p.sessionsDelta, 0);
  assert.equal(p.tokensDelta, 0);
});

test('buildPayload: clamps a huge first-backfill delta so it streams (no 400)', () => {
  // A heavy user's whole lifetime total on the first report (cursor at 0).
  const agg = { sessions: 250_000, inputTokens: 9_400_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const p = buildPayload(agg, { sessions: 0, tokens: 0 }, { instanceId: VALID_ID });
  assert.equal(p.tokensDelta, 5_000_000_000); // clamped to the per-report cap; the rest streams next flush
  assert.equal(p.sessionsDelta, 100_000);
});

test('buildPayload: empty aggregate produces zero deltas', () => {
  const p = buildPayload(null, { sessions: 0, tokens: 0 }, { instanceId: VALID_ID });
  assert.equal(p.sessionsDelta, 0);
  assert.equal(p.tokensDelta, 0);
});

test('readCursor: returns defaults when file missing', () => {
  const cur = readCursor('/nope/does-not-exist.json');
  assert.deepEqual(cur, { sessions: 0, tokens: 0, ts: 0 });
});

test('writeCursor → readCursor: round-trips', () => {
  const { cursorPath, cleanup } = makeTempPaths();
  try {
    writeCursor({ sessions: 3, tokens: 100, ts: 42 }, cursorPath);
    assert.deepEqual(readCursor(cursorPath), { sessions: 3, tokens: 100, ts: 42 });
  } finally { cleanup(); }
});

// ── flushCommunity branches ────────────────────────────────────────────

test('flushCommunity: disabled config → ok:false reason=disabled', async () => {
  const r = await flushCommunity({ community: { enabled: false } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
});

test('flushCommunity: missing instanceId → no-instance-id', async () => {
  const r = await flushCommunity({ community: { enabled: true, endpoint: 'https://x' } });
  assert.equal(r.reason, 'no-instance-id');
});

test('flushCommunity: missing endpoint → no-endpoint', async () => {
  const r = await flushCommunity({ community: { enabled: true, instanceId: VALID_ID } });
  assert.equal(r.reason, 'no-endpoint');
});

test('flushCommunity: missing aggregate file → no-aggregate', async () => {
  const r = await flushCommunity(
    { community: { enabled: true, instanceId: VALID_ID, endpoint: 'https://x' } },
    { aggregatePath: '/nope/aggregate.json', cursorPath: '/nope/cursor.json' },
  );
  assert.equal(r.reason, 'no-aggregate');
});

test('flushCommunity: no delta → ok with no fetch call', async () => {
  const paths = makeTempPaths();
  try {
    writeFileSync(paths.aggregatePath, JSON.stringify({ sessions: 5, inputTokens: 100 }));
    writeCursor({ sessions: 5, tokens: 100 }, paths.cursorPath);
    const calls = [];
    const r = await flushCommunity(
      { community: { enabled: true, instanceId: VALID_ID, endpoint: 'https://x' } },
      { aggregatePath: paths.aggregatePath, cursorPath: paths.cursorPath, fetchImpl: fakeFetch({}, calls) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.reason, 'no-delta');
    assert.equal(calls.length, 0, 'no fetch on empty delta');
  } finally { paths.cleanup(); }
});

test('flushCommunity: successful flush POSTs the payload and advances cursor', async () => {
  const paths = makeTempPaths();
  try {
    writeFileSync(paths.aggregatePath, JSON.stringify({
      sessions: 10, inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 100,
    }));
    writeCursor({ sessions: 4, tokens: 1_200 }, paths.cursorPath);
    const calls = [];
    const r = await flushCommunity(
      { community: { enabled: true, instanceId: VALID_ID, endpoint: 'https://example.test' } },
      { aggregatePath: paths.aggregatePath, cursorPath: paths.cursorPath, fetchImpl: fakeFetch({}, calls) },
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.delta, { sessions: 6, tokens: 600 });

    assert.equal(calls.length, 1, 'one POST');
    assert.equal(calls[0].url, 'https://example.test/report');
    assert.equal(calls[0].init.method, 'POST');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.instanceId, VALID_ID);
    assert.equal(body.sessionsDelta, 6);
    assert.equal(body.tokensDelta, 600);

    const cur = readCursor(paths.cursorPath);
    assert.equal(cur.sessions, 10, 'cursor advanced to current aggregate value');
    assert.equal(cur.tokens, 1_800);
  } finally { paths.cleanup(); }
});

test('flushCommunity: HTTP 429 → ok:false reason=rate-limited, cursor unchanged', async () => {
  const paths = makeTempPaths();
  try {
    writeFileSync(paths.aggregatePath, JSON.stringify({ sessions: 100, inputTokens: 100 }));
    writeCursor({ sessions: 0, tokens: 0 }, paths.cursorPath);
    const r = await flushCommunity(
      { community: { enabled: true, instanceId: VALID_ID, endpoint: 'https://x' } },
      { aggregatePath: paths.aggregatePath, cursorPath: paths.cursorPath, fetchImpl: fakeFetch({ status: 429 }) },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'rate-limited');
    const cur = readCursor(paths.cursorPath);
    assert.equal(cur.sessions, 0, 'cursor did NOT advance on a rejected report');
  } finally { paths.cleanup(); }
});

test('flushCommunity: network throw → ok:false reason=network', async () => {
  const paths = makeTempPaths();
  try {
    writeFileSync(paths.aggregatePath, JSON.stringify({ sessions: 5, inputTokens: 1 }));
    writeCursor({ sessions: 0, tokens: 0 }, paths.cursorPath);
    const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
    const r = await flushCommunity(
      { community: { enabled: true, instanceId: VALID_ID, endpoint: 'https://x' } },
      { aggregatePath: paths.aggregatePath, cursorPath: paths.cursorPath, fetchImpl },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'network');
    assert.match(r.error, /ECONNREFUSED/);
  } finally { paths.cleanup(); }
});

test('flushCommunity: HTTP 500 → ok:false reason=http-500, cursor unchanged', async () => {
  const paths = makeTempPaths();
  try {
    writeFileSync(paths.aggregatePath, JSON.stringify({ sessions: 5, inputTokens: 1 }));
    writeCursor({ sessions: 0, tokens: 0 }, paths.cursorPath);
    const r = await flushCommunity(
      { community: { enabled: true, instanceId: VALID_ID, endpoint: 'https://x' } },
      { aggregatePath: paths.aggregatePath, cursorPath: paths.cursorPath, fetchImpl: fakeFetch({ status: 500 }) },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'http-500');
    assert.equal(readCursor(paths.cursorPath).sessions, 0);
  } finally { paths.cleanup(); }
});

test('flushCommunity: strips trailing slashes from the endpoint', async () => {
  const paths = makeTempPaths();
  try {
    writeFileSync(paths.aggregatePath, JSON.stringify({ sessions: 1, inputTokens: 1 }));
    writeCursor({ sessions: 0, tokens: 0 }, paths.cursorPath);
    const calls = [];
    await flushCommunity(
      { community: { enabled: true, instanceId: VALID_ID, endpoint: 'https://example.test///' } },
      { aggregatePath: paths.aggregatePath, cursorPath: paths.cursorPath, fetchImpl: fakeFetch({}, calls) },
    );
    assert.equal(calls[0].url, 'https://example.test/report');
  } finally { paths.cleanup(); }
});

// ── leaderboard profile flush ──────────────────────────────────────────

test('buildProfilePayload: absolute lifetime totals + identity fields', () => {
  const agg = { sessions: 10, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 7_000_000_000, cacheWriteTokens: 0, activeMs: 7200, streak: 9 };
  const profileCfg = { handle: 'archer', displayName: 'Archer', githubUser: 'RARcodes', enabled: true };
  const p = buildProfilePayload(agg, profileCfg, { instanceId: VALID_ID, now: 5 });
  assert.equal(p.tokens, 7_000_001_500); // absolute sum, not a delta — no cap rejection
  assert.equal(p.sessions, 10);
  assert.equal(p.activeMs, 7200);
  assert.equal(p.streak, 9);
  assert.equal(p.handle, 'archer');
  assert.equal(p.githubUser, 'RARcodes');
  assert.equal(p.instanceId, VALID_ID);
  // no delta fields
  assert.equal(p.tokensDelta, undefined);
});

test('flushProfile: disabled unless publishable (enabled + valid handle)', async () => {
  const r1 = await flushProfile({ profile: { enabled: false, handle: 'archer' }, community: { instanceId: VALID_ID, endpoint: 'https://x.test' } });
  assert.equal(r1.reason, 'disabled');
  const r2 = await flushProfile({ profile: { enabled: true, handle: 'A' }, community: { instanceId: VALID_ID, endpoint: 'https://x.test' } });
  assert.equal(r2.reason, 'disabled'); // invalid handle → not publishable
});

test('flushProfile: needs an instanceId', async () => {
  const r = await flushProfile({ profile: { enabled: true, handle: 'archer' }, community: { endpoint: 'https://x.test' } });
  assert.equal(r.reason, 'no-instance-id');
});

test('flushProfile: POSTs absolute totals to /profile (no cursor)', async () => {
  const paths = makeTempPaths();
  try {
    writeFileSync(paths.aggregatePath, JSON.stringify({ sessions: 95, inputTokens: 0, outputTokens: 0, cacheReadTokens: 9_427_309_583, cacheWriteTokens: 0, activeMs: 189022681, streak: 7 }));
    const calls = [];
    const cfg = {
      profile: { enabled: true, handle: 'archer', displayName: 'Archer', githubUser: 'RARcodes' },
      community: { instanceId: VALID_ID, endpoint: 'https://example.test' },
    };
    const r = await flushProfile(cfg, { aggregatePath: paths.aggregatePath, fetchImpl: fakeFetch({ body: '{"ok":true,"profile":{}}' }, calls) });
    assert.equal(r.ok, true);
    assert.equal(calls[0].url, 'https://example.test/profile');
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.handle, 'archer');
    assert.equal(sent.tokens, 9_427_309_583); // the real 9.4B total goes through as an absolute
    assert.equal(sent.sessions, 95);
    assert.equal(r.totals.tokens, 9_427_309_583);
  } finally { paths.cleanup(); }
});
