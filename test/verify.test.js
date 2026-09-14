// src/verify.js — the gist-verification core and the daemon's background
// resume of a verification the user consented to but the server never
// confirmed (the 2026-08-20 → 09-11 KV write-cap outage). Network, gh and the
// config file are all injected/temp, so nothing here touches the real worker,
// GitHub, or the user's config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  resumeBackoffMs, inferLegacyVerifyIntent, withVerifyIntent, resumeDecision,
  runGistVerify, resumePendingVerify, markVerifiedLocally,
  RESUME_BASE_MS, RESUME_MAX_MS, RESUME_WINDOW_MS, PROOF_FILENAME,
} = await import('../src/verify.js');

const ID = '12345678-1234-4abc-abcd-1234567890ab';
const ENDPOINT = 'https://worker.test';
const HOUR = 3_600_000;

function cfgWith(profile = {}) {
  return {
    community: { instanceId: ID, endpoint: ENDPOINT },
    profile: { handle: 'octocat', enabled: true, githubUser: 'octocat', ...profile },
  };
}

function tempConfig(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-verify-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(obj, null, 2));
  return { path, read: () => JSON.parse(readFileSync(path, 'utf8')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A fake worker: routes by path, records every request body.
function fakeWorker({ start = { status: 200, body: { ok: true, token: 'vrf_t1' } },
  check = { status: 200, body: { ok: true, verified: true, githubUser: 'octocat' } } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body });
    const r = path === '/verify/start' ? start : check;
    if (r instanceof Error) throw r;
    return { status: r.status, ok: r.status < 400, json: async () => r.body };
  };
  return { fetchImpl, calls };
}

function fakePublish(result = { id: 'abc123', owner: 'octocat' }, { failEdit = false } = {}) {
  const calls = [];
  const publish = async (args) => {
    calls.push(args);
    if (args.gistId && failEdit) throw new Error('gh gist edit failed: not found');
    return args.gistId ? { id: args.gistId, owner: '' } : result;
  };
  return { publish, calls };
}

// ── pure helpers ────────────────────────────────────────────────────────

test('resumeBackoffMs: 30 min doubling to a 12 h ceiling', () => {
  assert.equal(resumeBackoffMs(1), RESUME_BASE_MS);
  assert.equal(resumeBackoffMs(2), 2 * RESUME_BASE_MS);
  assert.equal(resumeBackoffMs(4), 8 * RESUME_BASE_MS);
  assert.equal(resumeBackoffMs(20), RESUME_MAX_MS);
  assert.equal(resumeBackoffMs(0), RESUME_BASE_MS);
});

test('inferLegacyVerifyIntent: only the setup yes-path footprint', () => {
  const yes = { ghConnectAsked: true, enabled: true, githubUser: 'octocat', handle: 'octocat' };
  assert.equal(inferLegacyVerifyIntent(yes), true);
  assert.equal(inferLegacyVerifyIntent({ ...yes, verified: true }), false, 'already verified');
  assert.equal(inferLegacyVerifyIntent({ ...yes, ghConnectAsked: undefined }), false, 'never asked (pre-1.4)');
  assert.equal(inferLegacyVerifyIntent({ ...yes, enabled: false }), false, 'publishing off');
  assert.equal(inferLegacyVerifyIntent({ ...yes, githubUser: undefined }), false, 'said n / no gh login');
  assert.equal(inferLegacyVerifyIntent({ ...yes, githubUser: 'not a login!' }), false, 'invalid login');
  assert.equal(inferLegacyVerifyIntent({ ...yes, verifyPending: { gaveUpAt: 1 } }), false, 'never re-inferred after a give-up');
  assert.equal(inferLegacyVerifyIntent(undefined), false);
});

test('withVerifyIntent: stamps consent, keeps the earliest time + gist, resets the retry budget', () => {
  const fresh = withVerifyIntent({ profile: { handle: 'octocat' } }, 5000);
  assert.deepEqual(fresh.profile.verifyPending, { since: 5000 });
  assert.equal(fresh.profile.handle, 'octocat');

  const again = withVerifyIntent({ profile: { verifyPending: { since: 1000, gistId: 'abc123', attempts: 9, gaveUpAt: 7000 } } }, 9000);
  assert.deepEqual(again.profile.verifyPending, { since: 1000, gistId: 'abc123' });

  const legacy = withVerifyIntent({ profile: { verifyPending: { since: null } } }, 9000);
  assert.equal(legacy.profile.verifyPending.since, 9000, 'an undated legacy marker gets dated by a fresh consent');
});

test('resumeDecision: gates on marker, verified, give-up, publishability, window, backoff', () => {
  const now = 100 * HOUR;
  const base = cfgWith().profile;
  assert.deepEqual(resumeDecision(base, now), { go: false, why: 'none' });
  assert.deepEqual(resumeDecision({ ...base, verifyPending: {} }, now), { go: true });
  assert.equal(resumeDecision({ ...base, verified: true, verifyPending: {} }, now).why, 'verified');
  assert.equal(resumeDecision({ ...base, verifyPending: { gaveUpAt: 1 } }, now).why, 'gave-up');
  assert.equal(resumeDecision({ ...base, enabled: false, verifyPending: {} }, now).why, 'profile-off');
  assert.equal(resumeDecision({ ...base, verifyPending: { nextAt: now + 1 } }, now).why, 'backoff');
  assert.deepEqual(resumeDecision({ ...base, verifyPending: { nextAt: now } }, now), { go: true });
  assert.equal(resumeDecision({ ...base, verifyPending: { firstTryAt: now - RESUME_WINDOW_MS - 1 } }, now).why, 'expired');
});

// ── runGistVerify ───────────────────────────────────────────────────────

test('runGistVerify: token → proof gist → check, forwarding resume metadata', async () => {
  const w = fakeWorker();
  const g = fakePublish();
  const r = await runGistVerify(cfgWith(), { fetchImpl: w.fetchImpl, publish: g.publish, resumed: true, pendingSince: 1234 });
  assert.equal(r.ok, true);
  assert.equal(r.githubUser, 'octocat');
  assert.equal(r.gistId, 'abc123');
  assert.deepEqual(w.calls.map((c) => c.path), ['/verify/start', '/verify/check']);
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].filename, PROOF_FILENAME);
  assert.equal(g.calls[0].isPublic, true);
  assert.ok(g.calls[0].svg.includes('vrf_t1'), 'gist carries the worker token');
  assert.deepEqual(w.calls[1].body, { instanceId: ID, gistId: 'abc123', resumed: true, pendingSince: 1234 });
});

test('runGistVerify: an interactive first try sends no resume fields', async () => {
  const w = fakeWorker();
  await runGistVerify(cfgWith(), { fetchImpl: w.fetchImpl, publish: fakePublish().publish });
  assert.deepEqual(w.calls[1].body, { instanceId: ID, gistId: 'abc123' });
});

test('runGistVerify: /verify/start 500 (the outage) stops before any gist is published', async () => {
  const w = fakeWorker({ start: { status: 500, body: {} } });
  const g = fakePublish();
  const r = await runGistVerify(cfgWith(), { fetchImpl: w.fetchImpl, publish: g.publish });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'start');
  assert.equal(r.status, 500);
  assert.equal(g.calls.length, 0);
});

test('runGistVerify: network failure is reported, never thrown', async () => {
  const w = fakeWorker({ start: new Error('fetch failed') });
  const r = await runGistVerify(cfgWith(), { fetchImpl: w.fetchImpl, publish: fakePublish().publish });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'start');
  assert.equal(r.status, 0);
  assert.match(r.error, /fetch failed/);
});

test('runGistVerify: reuses an earlier proof gist; falls back to a new one if it cannot be edited', async () => {
  const w = fakeWorker();
  const g = fakePublish();
  const r = await runGistVerify(cfgWith(), { fetchImpl: w.fetchImpl, publish: g.publish, gistId: 'old999' });
  assert.equal(r.ok, true);
  assert.equal(g.calls.length, 1);
  assert.equal(g.calls[0].gistId, 'old999');
  assert.equal(w.calls[1].body.gistId, 'old999');

  const w2 = fakeWorker();
  const g2 = fakePublish({ id: 'new777', owner: 'octocat' }, { failEdit: true });
  const r2 = await runGistVerify(cfgWith(), { fetchImpl: w2.fetchImpl, publish: g2.publish, gistId: 'gone111' });
  assert.equal(r2.ok, true);
  assert.equal(g2.calls.length, 2);
  assert.equal(r2.gistId, 'new777');
});

test('runGistVerify: a failed check still hands back the gist id for reuse', async () => {
  const w = fakeWorker({ check: { status: 500, body: { error: 'boom' } } });
  const r = await runGistVerify(cfgWith(), { fetchImpl: w.fetchImpl, publish: fakePublish().publish });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'check');
  assert.equal(r.gistId, 'abc123');
  assert.equal(r.error, 'boom');
});

test('runGistVerify: missing identity/endpoint is a config failure with no network', async () => {
  const w = fakeWorker();
  const r = await runGistVerify({ profile: {} }, { fetchImpl: w.fetchImpl });
  assert.equal(r.stage, 'config');
  assert.equal(w.calls.length, 0);
});

// ── resumePendingVerify (daemon) ────────────────────────────────────────

test('resumePendingVerify: finishes a legacy (undated) connect and clears the marker', async () => {
  const cfg = cfgWith({ ghConnectAsked: true, verifyPending: { since: null } });
  const file = tempConfig(cfg);
  try {
    const w = fakeWorker();
    const logs = [];
    const r = await resumePendingVerify(cfg, {
      configPath: file.path, fetchImpl: w.fetchImpl, publish: fakePublish().publish,
      ghLoginImpl: () => 'octocat', log: (m) => logs.push(m),
    });
    assert.deepEqual(r, { attempted: true, ok: true });
    const saved = file.read();
    assert.equal(saved.profile.verified, true);
    assert.equal(saved.profile.githubUser, 'octocat');
    assert.equal(saved.profile.verifyPending, undefined);
    assert.equal(saved.profile.ghConnectAsked, true, 'unrelated fields untouched');
    assert.deepEqual(w.calls[1].body, { instanceId: ID, gistId: 'abc123', resumed: true }, 'undated → worker anchors on createdAt');
    assert.match(logs.join('\n'), /verified as @octocat/);
  } finally { file.cleanup(); }
});

test('resumePendingVerify: failure schedules a backoff and remembers the gist', async () => {
  const now = 50 * HOUR;
  const cfg = cfgWith({ verifyPending: { since: 1000 } });
  const file = tempConfig(cfg);
  try {
    const w = fakeWorker({ check: { status: 503, body: {} } });
    const r = await resumePendingVerify(cfg, {
      configPath: file.path, now: () => now, fetchImpl: w.fetchImpl, publish: fakePublish().publish,
      ghLoginImpl: () => 'octocat',
    });
    assert.equal(r.ok, false);
    const vp = file.read().profile.verifyPending;
    assert.equal(vp.since, 1000);
    assert.equal(vp.attempts, 1);
    assert.equal(vp.firstTryAt, now);
    assert.equal(vp.nextAt, now + RESUME_BASE_MS);
    assert.equal(vp.gistId, 'abc123');
    assert.match(vp.lastError, /^check: http-503/);

    // The next call inside the backoff window does nothing at all.
    const w2 = fakeWorker();
    const again = await resumePendingVerify(file.read(), {
      configPath: file.path, now: () => now + 60_000, fetchImpl: w2.fetchImpl, ghLoginImpl: () => 'octocat',
    });
    assert.deepEqual(again, { attempted: false, why: 'backoff' });
    assert.equal(w2.calls.length, 0);
  } finally { file.cleanup(); }
});

test('resumePendingVerify: never proves a different account than the one connected', async () => {
  const cfg = cfgWith({ verifyPending: { since: 1000 } });
  const file = tempConfig(cfg);
  try {
    const w = fakeWorker();
    const g = fakePublish();
    const r = await resumePendingVerify(cfg, {
      configPath: file.path, fetchImpl: w.fetchImpl, publish: g.publish, ghLoginImpl: () => 'someone-else',
    });
    assert.equal(r.ok, false);
    assert.equal(r.stage, 'gh');
    assert.equal(w.calls.length, 0, 'no worker call');
    assert.equal(g.calls.length, 0, 'no gist');
    assert.match(file.read().profile.verifyPending.lastError, /someone-else/);
  } finally { file.cleanup(); }
});

test('resumePendingVerify: gh logged out → waits, no network', async () => {
  const cfg = cfgWith({ verifyPending: { since: 1000 } });
  const file = tempConfig(cfg);
  try {
    const w = fakeWorker();
    const r = await resumePendingVerify(cfg, { configPath: file.path, fetchImpl: w.fetchImpl, ghLoginImpl: () => null });
    assert.equal(r.stage, 'gh');
    assert.equal(w.calls.length, 0);
    assert.equal(file.read().profile.verifyPending.attempts, 1);
  } finally { file.cleanup(); }
});

test('resumePendingVerify: gives up after the 14-day window and stays quiet', async () => {
  const now = 1000 * HOUR;
  const cfg = cfgWith({ verifyPending: { since: 1, firstTryAt: now - RESUME_WINDOW_MS - 1, attempts: 30 } });
  const file = tempConfig(cfg);
  try {
    const logs = [];
    const r = await resumePendingVerify(cfg, { configPath: file.path, now: () => now, log: (m) => logs.push(m), ghLoginImpl: () => 'octocat' });
    assert.deepEqual(r, { attempted: false, why: 'expired' });
    assert.equal(file.read().profile.verifyPending.gaveUpAt, now);
    assert.match(logs[0], /gave up/);
    const after = await resumePendingVerify(file.read(), { configPath: file.path, now: () => now + HOUR, ghLoginImpl: () => 'octocat' });
    assert.equal(after.why, 'gave-up');
  } finally { file.cleanup(); }
});

test('resumePendingVerify: a marker cleared meanwhile (e.g. `link`) is not resurrected', async () => {
  const cfg = cfgWith({ verifyPending: { since: 1000 } });
  const file = tempConfig({ ...cfg, profile: { ...cfg.profile, verifyPending: undefined, verified: true } });
  try {
    const w = fakeWorker({ start: { status: 500, body: {} } });
    await resumePendingVerify(cfg, { configPath: file.path, fetchImpl: w.fetchImpl, publish: fakePublish().publish, ghLoginImpl: () => 'octocat' });
    const saved = file.read();
    assert.equal(saved.profile.verifyPending, undefined);
    assert.equal(saved.profile.verified, true);
  } finally { file.cleanup(); }
});

test('markVerifiedLocally: leaves an unreadable config alone', () => {
  const file = tempConfig({});
  try {
    writeFileSync(file.path, '{ not json');
    assert.equal(markVerifiedLocally('octocat', { path: file.path }), false);
    assert.equal(readFileSync(file.path, 'utf8'), '{ not json');
  } finally { file.cleanup(); }
});

test('resumePendingVerify: trusts the on-disk marker over a stale in-memory config', async () => {
  const now = 10 * HOUR;
  const stale = cfgWith({ verifyPending: { since: 1000 } });          // what the daemon still holds
  const file = tempConfig(cfgWith({ verifyPending: { since: 1000, attempts: 1, nextAt: now + HOUR } }));
  try {
    const w = fakeWorker();
    const r = await resumePendingVerify(stale, { configPath: file.path, now: () => now, fetchImpl: w.fetchImpl, ghLoginImpl: () => 'octocat' });
    assert.deepEqual(r, { attempted: false, why: 'backoff' });
    assert.equal(w.calls.length, 0);

    const done = tempConfig(cfgWith({ verified: true }));
    try {
      const r2 = await resumePendingVerify(stale, { configPath: done.path, now: () => now, fetchImpl: w.fetchImpl, ghLoginImpl: () => 'octocat' });
      assert.equal(r2.attempted, false);
      assert.equal(w.calls.length, 0, 'already verified on disk → no second verification');
    } finally { done.cleanup(); }
  } finally { file.cleanup(); }
});
