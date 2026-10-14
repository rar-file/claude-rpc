// Coverage for src/community.js — the opt-in telemetry client. We
// exercise the pure helpers (buildPayload, osFamily, cursor I/O) and the
// flushCommunity branches using an injected fetch impl and temp paths
// for both the aggregate and the cursor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { buildPayload, osFamily, readCursor, writeCursor, flushCommunity,
  buildProfilePayload, flushProfile, ensureCursor, markCursorFresh, CURSOR_PATH, LEGACY_CURSOR_PATH } =
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

// ── cursor home + migration (ensureCursor / markCursorFresh) ───────────
// The cursor used to live in os.tmpdir(); a reboot wiped it and the next
// flush re-sent the install's whole lifetime, which the worker adds blindly.

test('cursor lives in the persistent data dir, not os.tmpdir()', async () => {
  const { DATA_DIR, STATE_DIR } = await import('../src/paths.js');
  assert.equal(CURSOR_PATH, join(DATA_DIR, 'community-cursor.json'));
  assert.equal(LEGACY_CURSOR_PATH, join(STATE_DIR, 'community-cursor.json'));
});

test('ensureCursor: adopts the legacy tmp cursor once and removes it', () => {
  const { dir, cleanup } = makeTempPaths();
  try {
    const path = join(dir, 'data', 'cursor.json');
    const legacyPath = join(dir, 'tmp', 'cursor.json');
    writeCursor({ sessions: 7, tokens: 900, ts: 5 }, legacyPath);
    const cur = ensureCursor({ sessions: 10, inputTokens: 1000 }, { path, legacyPath });
    assert.deepEqual(cur, { sessions: 7, tokens: 900, ts: 5 }, 'legacy cursor carried over verbatim');
    assert.deepEqual(readCursor(path), { sessions: 7, tokens: 900, ts: 5 });
    assert.equal(existsSync(legacyPath), false, 'legacy file removed after adoption');
  } finally { cleanup(); }
});

test('ensureCursor: an existing cursor wins over a stale legacy one', () => {
  const { dir, cleanup } = makeTempPaths();
  try {
    const path = join(dir, 'data', 'cursor.json');
    const legacyPath = join(dir, 'tmp', 'cursor.json');
    writeCursor({ sessions: 9, tokens: 990, ts: 9 }, path);
    writeCursor({ sessions: 1, tokens: 1, ts: 1 }, legacyPath);
    assert.equal(ensureCursor({ sessions: 10 }, { path, legacyPath }).sessions, 9);
  } finally { cleanup(); }
});

test('ensureCursor: no cursor anywhere → seeded from the aggregate (no lifetime re-send)', () => {
  const { dir, cleanup } = makeTempPaths();
  try {
    const path = join(dir, 'data', 'cursor.json');
    const agg = { sessions: 40, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 30, cacheWriteTokens: 4 };
    const cur = ensureCursor(agg, { path, legacyPath: join(dir, 'tmp', 'none.json'), now: 123 });
    assert.equal(cur.sessions, 40);
    assert.equal(cur.tokens, 1234);
    assert.equal(cur.seeded, true);
    assert.equal(readCursor(path).sessions, 40, 'seed persisted');
    const p = buildPayload(agg, cur, { instanceId: VALID_ID });
    assert.equal(p.sessionsDelta, 0);
    assert.equal(p.tokensDelta, 0);
  } finally { cleanup(); }
});

test('ensureCursor: an unreadable cursor file is re-seeded, not treated as zero', () => {
  const { dir, cleanup } = makeTempPaths();
  try {
    const path = join(dir, 'cursor.json');
    writeFileSync(path, '{not json');
    assert.equal(ensureCursor({ sessions: 12 }, { path, legacyPath: null }).sessions, 12);
  } finally { cleanup(); }
});

test('markCursorFresh: a new identity gets a zero cursor → first flush reports the history', async () => {
  const paths = makeTempPaths();
  try {
    const legacyPath = join(paths.dir, 'tmp', 'none.json');
    assert.equal(markCursorFresh({ path: paths.cursorPath, legacyPath }), true);
    assert.deepEqual(readCursor(paths.cursorPath), { sessions: 0, tokens: 0, ts: 0 });
    writeFileSync(paths.aggregatePath, JSON.stringify({ sessions: 25, inputTokens: 5000 }));
    const calls = [];
    const r = await flushCommunity(
      { community: { enabled: true, instanceId: VALID_ID, endpoint: 'https://w' } },
      { aggregatePath: paths.aggregatePath, cursorPath: paths.cursorPath, fetchImpl: fakeFetch({}, calls) },
    );
    assert.deepEqual(r.delta, { sessions: 25, tokens: 5000 });
  } finally { paths.cleanup(); }
});

test('markCursorFresh: keeps (or adopts) an existing cursor instead of zeroing it', () => {
  const { dir, cleanup } = makeTempPaths();
  try {
    const path = join(dir, 'data', 'cursor.json');
    const legacyPath = join(dir, 'tmp', 'cursor.json');
    writeCursor({ sessions: 3, tokens: 30, ts: 3 }, legacyPath);
    assert.equal(markCursorFresh({ path, legacyPath }), false);
    assert.equal(readCursor(path).sessions, 3, 'legacy cursor adopted, not replaced by zeros');
    assert.equal(markCursorFresh({ path, legacyPath }), false, 'idempotent');
    assert.equal(readCursor(path).sessions, 3);
  } finally { cleanup(); }
});

test('flushCommunity: a missing cursor never re-sends the lifetime as a delta', async () => {
  const paths = makeTempPaths();
  try {
    writeFileSync(paths.aggregatePath, JSON.stringify({ sessions: 500, inputTokens: 1_000_000 }));
    const calls = [];
    const r = await flushCommunity(
      { community: { enabled: true, instanceId: VALID_ID, endpoint: 'https://w' } },
      { aggregatePath: paths.aggregatePath, cursorPath: paths.cursorPath, fetchImpl: fakeFetch({}, calls) },
    );
    assert.equal(r.reason, 'no-delta');
    assert.equal(calls.length, 0, 'nothing POSTed');
  } finally { paths.cleanup(); }
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

// ── Claude Wrapped ─────────────────────────────────────────────────────

const { buildWrappedPayload, publishWrapped } = await import('../src/community.js');

test('buildWrappedPayload: year-scoped sums, model mix, and privacy-filtered projects', () => {
  const agg = {
    byDay: {
      '2026-03-01': {
        activeMs: 2 * 3_600_000, sessions: 2, userMessages: 30, cost: 4,
        inputTokens: 1000, outputTokens: 500, cacheReadTokens: 8500, cacheWriteTokens: 0,
        linesAdded: 100, linesRemoved: 20, ships: 3,
        projects: { visible: { activeMs: 2 * 3_600_000, tokens: 10000 } },
        byModel: { opus: { turns: 5, tokens: 9000, cost: 4 } },
      },
      '2026-03-02': {
        activeMs: 1 * 3_600_000, sessions: 1, userMessages: 10, cost: 1,
        inputTokens: 500, outputTokens: 250, cacheReadTokens: 250, cacheWriteTokens: 0,
        projects: { secret: { activeMs: 3_600_000, tokens: 1000 } },
        byModel: { sonnet: { turns: 2, tokens: 1000, cost: 1 } },
      },
      '2025-12-31': { activeMs: 9e7, sessions: 9, userMessages: 99, inputTokens: 5e6 }, // other year — excluded
    },
    longestStreak: 21,
    peakHour: { hour: 14, activeMs: 1 },
    toolBreakdown: { Read: 60, Edit: 40 },
    languages: { JavaScript: { edits: 10 } },
    sessionLengths: { count: 4, totalMs: 8 * 3_600_000, longestMs: 5 * 3_600_000, buckets: { h2to4: 1, gt4h: 1 } },
    compactionsByDay: { '2026-03-01': 2, '2025-01-01': 7 },
    subagentActiveMs: 1234,
  };
  // Name-level privacy: pattern-hide 'secret'.
  const cfg = { privacy: { patterns: ['secret'] } };
  const p = buildWrappedPayload(agg, cfg, { instanceId: VALID_ID, year: 2026 });
  assert.equal(p.year, 2026);
  const w = p.wrapped;
  assert.equal(w.activeMs, 3 * 3_600_000, 'other-year day excluded');
  assert.equal(w.sessions, 3);
  assert.equal(w.prompts, 40);
  assert.equal(w.tokens, 11000, 'all four token buckets, year-scoped');
  assert.equal(w.cachePct, Math.round((8750 / 11000) * 100));
  assert.equal(w.daysActive, 2);
  assert.equal(w.streakBest, 21);
  assert.equal(w.ships, 3);
  assert.equal(w.costUsd, 5);
  assert.equal(w.peakDay.date, '2026-03-01');
  assert.deepEqual(w.topProjects, [{ name: 'visible', activeMs: 2 * 3_600_000 }], 'pattern-matched project excluded');
  // Model share is by SPEND (matching the local wrapped slide): opus $4 vs
  // sonnet $1 → 80/20, names humanized.
  assert.deepEqual(w.topModels, [{ name: 'Opus', pct: 80 }, { name: 'Sonnet', pct: 20 }]);
  assert.deepEqual(w.topLanguages, [{ name: 'JavaScript', edits: 10 }], 'languages carry edit counts');
  assert.deepEqual(w.toolMix, [{ name: 'Read', pct: 60 }, { name: 'Edit', pct: 40 }]);
  assert.equal(w.marathonPct, 50, '2 of 4 sessions >= 2h');
  assert.equal(w.compactions, 2, 'compactions year-scoped');
});

test('publishWrapped: posts to /wrapped and surfaces the page URL; maps 403', async () => {
  const cfg = { community: { endpoint: 'https://worker.test' } };
  let posted = null;
  const okFetch = async (url, opts) => {
    posted = { url, body: JSON.parse(opts.body) };
    return { ok: true, status: 200, json: async () => ({ ok: true, url: 'https://claude-rpc.com/wrapped/archer?year=2026', handle: 'archer', year: 2026 }) };
  };
  const payload = { instanceId: VALID_ID, year: 2026, wrapped: { sessions: 1 } };
  const res = await publishWrapped(cfg, payload, { fetchImpl: okFetch });
  assert.equal(res.ok, true);
  assert.equal(res.handle, 'archer');
  assert.equal(posted.url, 'https://worker.test/wrapped');
  assert.equal(posted.body.year, 2026);

  const forbidden = async () => ({ ok: false, status: 403, json: async () => ({ error: 'no profile' }) });
  const noProfile = await publishWrapped(cfg, payload, { fetchImpl: forbidden });
  assert.equal(noProfile.ok, false);
  assert.equal(noProfile.reason, 'no-profile');

  const offline = await publishWrapped({ community: {} }, payload, {});
  assert.equal(offline.reason, 'no-endpoint');
});
