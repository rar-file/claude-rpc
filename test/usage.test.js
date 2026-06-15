// src/usage.js — subscription-usage fetch, normalization, cache, formatting.
// The fixture is a real /api/oauth/usage response captured 2026-06-12; the
// endpoint is internal, so normalizeUsage must survive unknown/experimental
// buckets coming and going.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  normalizeUsage, fetchUsage, readClaudeCredentials,
  writeUsageCache, readUsageCache, USAGE_STALE_MS,
  fmtResetTime, fmtResetDay,
} = await import('../src/usage.js');

const FIXTURE = {
  five_hour: { utilization: 11.0, resets_at: '2026-06-12T17:59:59.093648+00:00' },
  seven_day: { utilization: 34.4, resets_at: '2026-06-17T09:59:59.093667+00:00' },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: { utilization: 0.0, resets_at: '2026-06-17T10:00:00.093676+00:00' },
  seven_day_cowork: null,          // experimental buckets observed in the wild —
  tangelo: null,                   // must be ignored, never crash
  extra_usage: { is_enabled: false, monthly_limit: null },
};

test('normalizeUsage: real fixture → rounded ints, absent buckets null, unknowns ignored', () => {
  const u = normalizeUsage(FIXTURE);
  assert.equal(u.sessionPct, 11);
  assert.equal(u.weeklyPct, 34, 'utilization rounds to an integer');
  assert.equal(u.weeklyOpusPct, null, 'null bucket → null, not 0');
  assert.equal(u.weeklySonnetPct, 0, 'a real 0% stays 0');
  assert.match(u.weeklyResetsAt, /^2026-06-17/);
  assert.equal(normalizeUsage({}), null, 'no recognizable buckets → null');
  assert.equal(normalizeUsage(null), null);
});

test('fetchUsage: happy path normalizes, attaches plan, and sends the token only as a Bearer header', async () => {
  const creds = { accessToken: 'tok-123', expiresAt: Date.now() + 60_000, subscriptionType: 'max' };
  let sawUrl = null, sawAuth = null;
  const fetchImpl = async (url, opts) => {
    sawUrl = url; sawAuth = opts.headers.Authorization;
    return { ok: true, status: 200, json: async () => FIXTURE };
  };
  const r = await fetchUsage({ fetchImpl, creds });
  assert.equal(r.ok, true);
  assert.equal(r.usage.weeklyPct, 34);
  assert.equal(r.usage.plan, 'max');
  assert.ok(r.usage.fetchedAt > 0);
  assert.match(sawUrl, /^https:\/\/api\.anthropic\.com\/api\/oauth\/usage$/);
  assert.equal(sawAuth, 'Bearer tok-123');
});

test('fetchUsage: every failure mode resolves, never throws', async () => {
  const live = { accessToken: 't', expiresAt: Date.now() + 60_000 };
  let r = await fetchUsage({ creds: null });
  assert.deepEqual([r.ok, r.reason], [false, 'no-credentials']);
  r = await fetchUsage({ creds: { accessToken: 't', expiresAt: 1 } });
  assert.deepEqual([r.ok, r.reason], [false, 'token-expired']);
  r = await fetchUsage({ creds: live, fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.deepEqual([r.ok, r.reason], [false, 'unauthorized']);
  r = await fetchUsage({ creds: live, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.deepEqual([r.ok, r.reason], [false, 'http-503']);
  r = await fetchUsage({ creds: live, fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual([r.ok, r.reason], [false, 'network']);
  r = await fetchUsage({ creds: live, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  assert.deepEqual([r.ok, r.reason], [false, 'no-buckets']);
});

test('credentials: reads claudeAiOauth from the file, null when absent or malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crpc-usage-'));
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'abc', expiresAt: 9, subscriptionType: 'pro' },
  }));
  const creds = readClaudeCredentials({ home: dir });
  assert.equal(creds.accessToken, 'abc');
  assert.equal(creds.subscriptionType, 'pro');
  assert.equal(readClaudeCredentials({ home: join(dir, 'nope') }), null);
  writeFileSync(join(dir, '.credentials.json'), 'not json');
  // Malformed file → null on Linux/Windows (macOS would fall through to keychain).
  if (process.platform !== 'darwin') assert.equal(readClaudeCredentials({ home: dir }), null);
});

test('cache: round-trips while fresh, collapses to null when stale or missing', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'crpc-usage-')), 'usage.json');
  const now = 1_750_000_000_000;
  writeUsageCache({ weeklyPct: 34, sessionPct: 11, fetchedAt: now }, path);
  assert.equal(readUsageCache({ path, now: now + 60_000 }).weeklyPct, 34);
  assert.equal(readUsageCache({ path, now: now + USAGE_STALE_MS + 1 }), null, 'stale → no data');
  assert.equal(readUsageCache({ path: path + '.missing' }), null);
});

test('reset formatting: card-friendly time and day strings', () => {
  const now = new Date('2026-06-12T12:00:00');
  const wed = new Date('2026-06-17T10:00:00');
  assert.equal(fmtResetDay(wed.toISOString(), now), 'Wed');
  assert.equal(fmtResetDay(new Date('2026-06-12T18:00:00').toISOString(), now), 'today');
  assert.equal(fmtResetDay(new Date('2026-06-13T02:00:00').toISOString(), now), 'tomorrow');
  assert.equal(fmtResetDay(null), '');
  const six = new Date('2026-06-12T18:00:00');
  assert.equal(fmtResetTime(six.toISOString()), '6pm');
  const halfPast = new Date('2026-06-12T06:30:00');
  assert.equal(fmtResetTime(halfPast.toISOString()), '6:30am');
  assert.equal(fmtResetTime(null), '');
});

// The vars contract: usage rides into buildVars on state.usage; absent →
// every usage var is '' so `requires`-gated frames vanish.
test('buildVars: usage vars present with data, all-empty without', async () => {
  const { buildVars } = await import('../src/format.js');
  const base = { status: 'idle', cwd: '/tmp/x', tokens: {}, filesOpened: [], filesEdited: [], filesRead: [] };
  const withUsage = buildVars({ ...base, usage: {
    sessionPct: 19, weeklyPct: 35, weeklySonnetPct: 0, weeklyOpusPct: null,
    sessionResetsAt: '2026-06-12T18:00:00', weeklyResetsAt: '2026-06-17T10:00:00', plan: 'max',
  } }, {}, {});
  assert.equal(withUsage.usageWeeklyPct, 35);
  assert.equal(withUsage.usageSessionPct, 19);
  assert.match(withUsage.usageStateLabel, /^session 19% · resets /);
  assert.ok(!withUsage.usageStateLabel.includes('weekly'), 'state line must not repeat the weekly% the frame details already show');
  assert.equal(withUsage.usagePlan, 'Max');
  const without = buildVars(base, {}, {});
  assert.equal(without.usageWeeklyPct, '');
  assert.equal(without.usageStateLabel, '');
});

test('cache: a future-dated fetchedAt is rejected (clock skew / corrupt write)', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'crpc-usage-')), 'usage.json');
  const now = 1_750_000_000_000;
  // 10 min in the future would otherwise read as "fresh forever".
  writeUsageCache({ weeklyPct: 5, fetchedAt: now + 600_000 }, path);
  assert.equal(readUsageCache({ path, now }), null, 'future-dated → no data');
  // A small skew within tolerance still reads.
  writeUsageCache({ weeklyPct: 5, fetchedAt: now + 10_000 }, path);
  assert.equal(readUsageCache({ path, now }).weeklyPct, 5);
});

test('fetchUsage: a token within 30s of expiry is treated as expired (skew margin)', async () => {
  const now = 1_750_000_000_000;
  const r = await fetchUsage({
    creds: { accessToken: 't', expiresAt: now + 20_000 }, now,
    fetchImpl: async () => { throw new Error('should not fetch a doomed request'); },
  });
  assert.deepEqual([r.ok, r.reason], [false, 'token-expired']);
});
