// Unit tests for the worker's route handlers. We don't run wrangler dev
// here — instead we exercise the exported handler functions directly
// against an in-memory KV stub that mimics the binding's surface
// (`get`, `put` with `expirationTtl`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validateReport, handleReport, handleBadge, handleUserBadge, handleUserCard, handleJson, handleRef, handleRefs,
  validateProfile, handleProfile, handleLeaderboard, handleVerifyStart, handleVerifyCheck,
  handleProfileGet, pruneBoardIndex } = await import('../src/index.js');
const worker = (await import('../src/index.js')).default;

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k).value : null; },
    async put(k, v, opts = {}) {
      store.set(k, { value: String(v), ttl: opts.expirationTtl || null });
    },
    async delete(k) { store.delete(k); },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function makeEnv() { return { TOTALS: makeKv() }; }

function reportRequest(body) {
  return new Request('http://localhost/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = {
  instanceId: '11111111-2222-3333-4444-555555555555',
  sessionsDelta: 2,
  tokensDelta: 12345,
  version: '0.7.0',
  osFamily: 'linux',
  ts: Date.now(),
};

// ── validateReport ─────────────────────────────────────────────────────

test('validateReport: accepts a well-formed payload', () => {
  assert.equal(validateReport(validBody), null);
});

test('validateReport: rejects non-objects', () => {
  assert.match(validateReport(null), /object/);
  assert.match(validateReport('hi'), /object/);
});

test('validateReport: rejects bad instanceId', () => {
  assert.match(validateReport({ ...validBody, instanceId: 'not-a-uuid' }), /instanceId/);
  assert.match(validateReport({ ...validBody, instanceId: null }), /instanceId/);
});

test('validateReport: rejects deltas out of range', () => {
  assert.match(validateReport({ ...validBody, sessionsDelta: -1 }), /sessionsDelta/);
  assert.match(validateReport({ ...validBody, sessionsDelta: 999_999_999 }), /sessionsDelta/);
  assert.match(validateReport({ ...validBody, tokensDelta: -1 }), /tokensDelta/);
});

test('validateReport: rejects empty deltas (no real signal)', () => {
  assert.match(validateReport({ ...validBody, sessionsDelta: 0, tokensDelta: 0 }), /no delta/);
});

test('validateReport: rejects fractional / non-integer deltas', () => {
  assert.match(validateReport({ ...validBody, tokensDelta: 1.5 }), /tokensDelta/);
  assert.match(validateReport({ ...validBody, sessionsDelta: 2.7 }), /sessionsDelta/);
  assert.match(validateReport({ ...validBody, tokensDelta: 'NaN' }), /tokensDelta/);
});

test('validateReport: rejects unknown osFamily', () => {
  assert.match(validateReport({ ...validBody, osFamily: 'freebsd' }), /osFamily/);
});

test('validateReport: rejects oversized version string', () => {
  assert.match(validateReport({ ...validBody, version: 'x'.repeat(100) }), /version/);
});

// ── handleReport ───────────────────────────────────────────────────────

test('handleReport: increments running totals on success', async () => {
  const env = makeEnv();
  const res = await handleReport(reportRequest(validBody), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.totals.sessions, 2);
  assert.equal(j.totals.tokens, 12345);
});

test('handleReport: accumulates across multiple instances', async () => {
  const env = makeEnv();
  await handleReport(reportRequest({ ...validBody, instanceId: 'aaaaaaaa-1111-2222-3333-444444444444' }), env);
  const res2 = await handleReport(reportRequest({ ...validBody, instanceId: 'bbbbbbbb-1111-2222-3333-444444444444', sessionsDelta: 3, tokensDelta: 1000 }), env);
  const j2 = await res2.json();
  assert.equal(j2.totals.sessions, 5);
  assert.equal(j2.totals.tokens, 13345);
});

test('handleReport: rate-limits a second report from the same instance', async () => {
  const env = makeEnv();
  await handleReport(reportRequest(validBody), env);
  const res2 = await handleReport(reportRequest({ ...validBody, sessionsDelta: 1, tokensDelta: 1 }), env);
  assert.equal(res2.status, 429);
  // Totals must not have advanced on the rejected report.
  const total = JSON.parse(await env.TOTALS.get('total:counters'));
  assert.equal(total.sessions, 2);
});

test('handleReport: IP-scoped limiter blocks rotated instanceIds past the window cap', async () => {
  const env = makeEnv();
  const ip = '203.0.113.7';
  const mk = (body) => new Request('http://localhost/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
  // Rotate a fresh UUID each time so the per-instance limiter never fires;
  // only the IP limiter (20/window) should stop us.
  let accepted = 0;
  let blocked = 0;
  for (let i = 0; i < 25; i++) {
    const id = `${String(i).padStart(8, '0')}-2222-3333-4444-555555555555`;
    const res = await handleReport(mk({ ...validBody, instanceId: id }), env);
    if (res.status === 200) accepted++;
    else if (res.status === 429) { blocked++; assert.match((await res.json()).error, /ip/); }
  }
  assert.equal(accepted, 20, 'exactly IP_RATE_MAX reports accepted in the window');
  assert.equal(blocked, 5, 'the rest are 429-ed by the IP limiter');
});

test('handleReport: missing CF-Connecting-IP still bounds volume via the shared bucket', async () => {
  const env = makeEnv();
  // No CF-Connecting-IP header (as the existing in-memory tests send). The
  // first report must still succeed, but rotated UUIDs are bounded too.
  let accepted = 0;
  for (let i = 0; i < 25; i++) {
    const id = `${String(i).padStart(8, '0')}-9999-3333-4444-555555555555`;
    const res = await handleReport(reportRequest({ ...validBody, instanceId: id }), env);
    if (res.status === 200) accepted++;
  }
  assert.equal(accepted, 20, 'headerless reports share one bucket capped at IP_RATE_MAX');
});

test('handleReport: rejects invalid JSON with 400', async () => {
  const env = makeEnv();
  const req = new Request('http://localhost/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json',
  });
  const res = await handleReport(req, env);
  assert.equal(res.status, 400);
});

test('handleReport: records a `seen:<id>` dedup marker', async () => {
  const env = makeEnv();
  await handleReport(reportRequest(validBody), env);
  const seen = await env.TOTALS.get(`seen:${validBody.instanceId}`);
  assert.ok(seen, 'seen marker written');
  const parsed = JSON.parse(seen);
  assert.equal(parsed.version, '0.7.0');
  assert.equal(parsed.osFamily, 'linux');
});

// ── KV-write reduction (free-tier 1k-writes/day budget) ──────────────────

test('handleReport: writes ONE combined total:counters key, not the split keys', async () => {
  const env = makeEnv();
  const res = await handleReport(reportRequest(validBody), env);
  assert.equal(res.status, 200);
  assert.ok(env.TOTALS.store.has('total:counters'), 'combined counter written');
  assert.equal(env.TOTALS.store.has('total:sessions'), false, 'legacy split key not written');
  assert.equal(env.TOTALS.store.has('total:tokens'), false);
  const c = JSON.parse(env.TOTALS.store.get('total:counters').value);
  assert.equal(c.sessions, validBody.sessionsDelta);
  assert.equal(c.tokens, validBody.tokensDelta);
});

test('handleReport: seeds the combined counter from legacy split keys (no data loss)', async () => {
  const env = makeEnv();
  await env.TOTALS.put('total:sessions', '900');
  await env.TOTALS.put('total:tokens', '23000000000');
  const res = await handleReport(reportRequest({ ...validBody, sessionsDelta: 2, tokensDelta: 1000 }), env);
  const j = await res.json();
  assert.equal(j.totals.sessions, 902, 'carried over legacy sessions + delta');
  assert.equal(j.totals.tokens, 23000001000);
});

test('handleBadge / handleJson still read the legacy split keys (back-compat)', async () => {
  const env = makeEnv();
  await env.TOTALS.put('total:sessions', '1234');
  await env.TOTALS.put('total:tokens', '5678');
  const badge = await (await handleBadge('sessions', env)).text();
  assert.match(badge, /1\.2k/);
  const j = await (await handleJson(env)).json();
  assert.equal(j.tokens, 5678);
});

test('handleReport: does NOT rewrite a fresh seen marker (write throttle)', async () => {
  const env = makeEnv();
  await env.TOTALS.put(`seen:${validBody.instanceId}`,
    JSON.stringify({ ts: Date.now(), version: 'OLD', osFamily: 'linux' }));
  await handleReport(reportRequest(validBody), env);
  const seen = JSON.parse(env.TOTALS.store.get(`seen:${validBody.instanceId}`).value);
  assert.equal(seen.version, 'OLD', 'fresh marker left untouched (no KV write)');
});

test('handleReport: refreshes a stale (>24h) seen marker', async () => {
  const env = makeEnv();
  await env.TOTALS.put(`seen:${validBody.instanceId}`,
    JSON.stringify({ ts: Date.now() - 25 * 60 * 60 * 1000, version: 'OLD', osFamily: 'linux' }));
  await handleReport(reportRequest(validBody), env);
  const seen = JSON.parse(env.TOTALS.store.get(`seen:${validBody.instanceId}`).value);
  assert.equal(seen.version, validBody.version, 'stale marker refreshed to current');
});

test('handleProfile: steady-state re-publish skips the handle: write', async () => {
  const env = makeEnv();
  await handleProfile(profileRequest(profileBody), env);
  assert.equal(env.TOTALS.store.get(`handle:${profileBody.handle}`).value, profileBody.instanceId);
  // Allow a second publish through the per-instance limiter, then spy on writes.
  for (const k of [...env.TOTALS.store.keys()]) if (k.startsWith('rate:')) env.TOTALS.store.delete(k);
  const written = new Set();
  const origPut = env.TOTALS.put.bind(env.TOTALS);
  env.TOTALS.put = async (k, v, o) => { written.add(k); return origPut(k, v, o); };
  await handleProfile(profileRequest({ ...profileBody, tokens: 4000 }), env);
  assert.equal(written.has(`handle:${profileBody.handle}`), false, 'unchanged handle mapping not rewritten');
  assert.ok([...written].some((k) => k.startsWith('pf:')), 'pf still written (stats changed)');
});

// ── handleBadge ────────────────────────────────────────────────────────

test('handleBadge sessions: serves an SVG badge with the running total', async () => {
  const env = makeEnv();
  await env.TOTALS.put('total:sessions', '1234');
  const res = await handleBadge('sessions', env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /image\/svg/);
  const body = await res.text();
  assert.match(body, /<svg /);
  assert.match(body, /1\.2k/, 'fmtNum scales 1234 → "1.2k"');
});

test('handleBadge tokens: zero totals render "0" cleanly', async () => {
  const env = makeEnv();
  const res = await handleBadge('tokens', env);
  const body = await res.text();
  assert.match(body, /community.+tokens/);
  assert.match(body, />0</);
});

test('handleBadge: unknown metric → 404', async () => {
  const env = makeEnv();
  const res = await handleBadge('whatever', env);
  assert.equal(res.status, 404);
});

// ── handleUserBadge (per-user README badge) ──────────────────────────────

// Seed a public profile directly in KV (pf:<id> + handle:<h> → id), the same
// shape handleProfile writes — no rate-limit / validation dance needed here.
async function seedProfile(env, handle, fields) {
  const id = '99999999-0000-0000-0000-000000000001';
  await env.TOTALS.put(`pf:${id}`, JSON.stringify({ handle, verified: true, ...fields }));
  await env.TOTALS.put(`handle:${handle}`, id);
  return id;
}
function badgeUrl(handle, qs = '') {
  return new URL(`http://localhost/badge/${handle}.svg${qs}`);
}

test('handleUserBadge: defaults to tokens and renders the profile total', async () => {
  const env = makeEnv();
  await seedProfile(env, 'archer', { tokens: 1_500_000, sessions: 42, activeMs: 9_000_000, streak: 7 });
  const res = await handleUserBadge('archer', badgeUrl('archer'), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /image\/svg/);
  const body = await res.text();
  assert.match(body, /claude.+tokens/);
  assert.match(body, /1\.50M/, 'fmtNum scales 1.5M tokens');
});

test('handleUserBadge: metric=hours renders fmtHours from activeMs', async () => {
  const env = makeEnv();
  await seedProfile(env, 'archer', { tokens: 10, activeMs: 9_000_000, streak: 7 });
  const res = await handleUserBadge('archer', badgeUrl('archer', '?metric=hours'), env);
  const body = await res.text();
  assert.match(body, /claude.+hours/);
  assert.match(body, /2\.5h/, '9,000,000ms → 2.5h');
});

test('handleUserBadge: metric=streak renders "<n> days"', async () => {
  const env = makeEnv();
  await seedProfile(env, 'archer', { streak: 12 });
  const res = await handleUserBadge('archer', badgeUrl('archer', '?metric=streak'), env);
  const body = await res.text();
  assert.match(body, /12 days/);
});

test('handleUserBadge: ?label= overrides the left label (sanitized)', async () => {
  const env = makeEnv();
  await seedProfile(env, 'archer', { tokens: 5 });
  const res = await handleUserBadge('archer', badgeUrl('archer', '?label=my%20claude'), env);
  const body = await res.text();
  assert.match(body, /my claude/);
});

test('handleUserBadge: unknown handle → placeholder SVG (200, not broken image)', async () => {
  const env = makeEnv();
  const res = await handleUserBadge('nobody', badgeUrl('nobody'), env);
  assert.equal(res.status, 200, 'always 200 so the README <img> renders');
  assert.match(res.headers.get('Content-Type'), /image\/svg/);
  const body = await res.text();
  assert.match(body, /no profile/);
});

test('handleUserBadge: routes through the worker entry point', async () => {
  const env = makeEnv();
  await seedProfile(env, 'archer', { tokens: 2_000_000 });
  const res = await worker.fetch(new Request('http://localhost/badge/archer.svg?metric=tokens'), env);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /2\.00M/);
});

// ── handleUserCard (per-user stat card) ──────────────────────────────────

test('handleUserCard: renders all four metrics from the profile', async () => {
  const env = makeEnv();
  await seedProfile(env, 'archer', { displayName: 'Archer', tokens: 1_500_000, sessions: 42, activeMs: 9_000_000, streak: 7 });
  const res = await handleUserCard('archer', env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /image\/svg/);
  const body = await res.text();
  assert.match(body, /<svg /);
  assert.match(body, /Archer/, 'shows the display name');
  assert.match(body, /1\.50M/, 'tokens');
  assert.match(body, />42</, 'sessions');
  assert.match(body, /2\.5h/, 'hours from activeMs');
  assert.match(body, />7d</, 'streak');
});

test('handleUserCard: verified profile draws the verified stamp', async () => {
  const env = makeEnv();
  await seedProfile(env, 'archer', { tokens: 1, verified: true });
  const body = await (await handleUserCard('archer', env)).text();
  assert.match(body, /Claude Code · verified/);
});

test('handleUserCard: unknown handle → placeholder card (200, not broken image)', async () => {
  const env = makeEnv();
  const res = await handleUserCard('nobody', env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /image\/svg/);
  const body = await res.text();
  assert.match(body, /no public profile yet/);
});

test('handleUserCard: routes through the worker entry point', async () => {
  const env = makeEnv();
  await seedProfile(env, 'archer', { tokens: 2_000_000 });
  const res = await worker.fetch(new Request('http://localhost/card/archer.svg'), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /2\.00M/);
});

// ── handleJson ─────────────────────────────────────────────────────────

test('handleJson: returns both totals + schemaVersion', async () => {
  const env = makeEnv();
  await env.TOTALS.put('total:sessions', '42');
  await env.TOTALS.put('total:tokens', '999');
  const res = await handleJson(env);
  const j = await res.json();
  assert.equal(j.sessions, 42);
  assert.equal(j.tokens, 999);
  assert.equal(j.schemaVersion, 1);
});

// ── referral attribution ──────────────────────────────────────────────

function refRequest(s) {
  return new URL(`http://localhost/ref${s == null ? '' : `?s=${encodeURIComponent(s)}`}`);
}

test('handleRef: counts an allowlisted source and returns 204', async () => {
  const env = makeEnv();
  const res = await handleRef(refRequest('discord'), env);
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(await env.TOTALS.get('ref:discord'), '1');
});

test('handleRef: accumulates repeat hits for the same source', async () => {
  const env = makeEnv();
  await handleRef(refRequest('wrapped'), env);
  await handleRef(refRequest('wrapped'), env);
  await handleRef(refRequest('wrapped'), env);
  assert.equal(await env.TOTALS.get('ref:wrapped'), '3');
});

test('handleRef: ignores unknown sources (no KV pollution)', async () => {
  const env = makeEnv();
  await handleRef(refRequest('evil-junk'), env);
  await handleRef(refRequest(''), env);
  await handleRef(refRequest(null), env);
  assert.equal(env.TOTALS.store.size, 0, 'nothing written for non-allowlisted sources');
});

test('handleRef: source matching is case-insensitive', async () => {
  const env = makeEnv();
  await handleRef(refRequest('Discord'), env);
  assert.equal(await env.TOTALS.get('ref:discord'), '1');
});

test('handleRefs: returns a by-source breakdown with a total', async () => {
  const env = makeEnv();
  await env.TOTALS.put('ref:discord', '7');
  await env.TOTALS.put('ref:wrapped', '3');
  await env.TOTALS.put('total:sessions', '99'); // must NOT leak into refs
  const res = await handleRefs(env);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
  const j = await res.json();
  assert.deepEqual(j.refs, { discord: 7, wrapped: 3 });
  assert.equal(j.total, 10);
});

test('handleJson: includes CORS so the stats page can fetch cross-origin', async () => {
  const res = await handleJson(makeEnv());
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});

test('default export: routes /ref and /refs.json', async () => {
  const env = makeEnv();
  assert.equal((await worker.fetch(new Request('http://localhost/ref?s=hn'), env)).status, 204);
  const refs = await (await worker.fetch(new Request('http://localhost/refs.json'), env)).json();
  assert.equal(refs.refs.hn, 1);
});

// ── default export (route dispatch) ────────────────────────────────────

test('default export: routes /health to a 200 ok', async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request('http://localhost/health'), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
});

test('default export: unknown route → 404', async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request('http://localhost/nope'), env);
  assert.equal(res.status, 404);
});

test('default export: wrong method on /report → 404', async () => {
  const env = makeEnv();
  const res = await worker.fetch(new Request('http://localhost/report', { method: 'GET' }), env);
  assert.equal(res.status, 404);
});

// ── leaderboard / profiles ─────────────────────────────────────────────

const profileBody = {
  instanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  handle: 'archer',
  displayName: 'Archer',
  tokens: 1000,
  sessions: 3,
  activeMs: 60000,
  streak: 5,
  version: '0.13.2',
  osFamily: 'linux',
};

function profileRequest(body) {
  return new Request('http://localhost/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('validateProfile: accepts a well-formed profile', () => {
  assert.equal(validateProfile(profileBody), null);
});

test('validateProfile: rejects bad handle / github / totals / id', () => {
  assert.match(validateProfile({ ...profileBody, handle: '!' }), /handle/);
  assert.match(validateProfile({ ...profileBody, githubUser: '-bad' }), /githubUser/);
  assert.match(validateProfile({ ...profileBody, tokens: -1 }), /tokens/);
  assert.match(validateProfile({ ...profileBody, instanceId: 'x' }), /instanceId/);
});

test('handleProfile: SETS absolute totals (idempotent, not accumulated)', async () => {
  const env = makeEnv();
  let res = await handleProfile(profileRequest(profileBody), env);
  assert.equal(res.status, 200);
  let j = await res.json();
  assert.equal(j.profile.tokens, 1000);
  assert.equal(j.profile.verified, false);
  // A later report SETS the latest absolute totals (no double-counting).
  env.TOTALS.store.delete('rate:profile:' + profileBody.instanceId);
  res = await handleProfile(profileRequest({ ...profileBody, tokens: 2000, sessions: 9 }), env);
  j = await res.json();
  assert.equal(j.profile.tokens, 2000);
  assert.equal(j.profile.sessions, 9);
});

test('handleProfile: ignores client-supplied githubUser (no impersonation)', async () => {
  const env = makeEnv();
  // An unverified caller tries to assert someone else's GitHub identity.
  const res = await handleProfile(profileRequest({ ...profileBody, githubUser: 'torvalds' }), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.profile.verified, false);
  assert.equal(j.profile.githubUser, null, 'only the verify/link flow may set githubUser');
});

test('handleProfile: accepts a multi-billion lifetime total (the v0.13.2 400 bug)', async () => {
  const env = makeEnv();
  const res = await handleProfile(profileRequest({ ...profileBody, tokens: 9_427_309_583 }), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.profile.tokens, 9_427_309_583); // under the 1T ceiling — not clamped, not rejected
});

test('handleProfile: clamps an absurd total to the ceiling', async () => {
  const env = makeEnv();
  const res = await handleProfile(profileRequest({ ...profileBody, tokens: 9e15 }), env);
  const j = await res.json();
  assert.equal(j.profile.tokens, 1_000_000_000_000); // clamped to MAX_PF_TOKENS
});

test('handleProfile: a client cannot self-assert verified=true', async () => {
  const env = makeEnv();
  const res = await handleProfile(profileRequest({ ...profileBody, verified: true }), env);
  const j = await res.json();
  assert.equal(j.profile.verified, false);
});

test('handleProfile: handle uniqueness is enforced (409)', async () => {
  const env = makeEnv();
  await handleProfile(profileRequest(profileBody), env);
  const res = await handleProfile(
    profileRequest({ ...profileBody, instanceId: '99999999-8888-7777-6666-555555555555' }),
    env,
  );
  assert.equal(res.status, 409);
});

test('handleLeaderboard: verified ranks first, then by metric', async () => {
  const env = makeEnv();
  // Populate board:index directly (the source of truth for ranking).
  await env.TOTALS.put('board:index', JSON.stringify({
    '11111111-1111-1111-1111-111111111111': { handle: 'whale', verified: false, tokens: 9_999_999_999, sessions: 1, activeMs: 0, streak: 0, displayName: null, githubUser: null },
    '22222222-2222-2222-2222-222222222222': { handle: 'realdev', verified: true, tokens: 5000, sessions: 10, activeMs: 0, streak: 0, displayName: null, githubUser: null },
  }));
  const res = await handleLeaderboard(new URL('http://localhost/leaderboard?metric=tokens'), env);
  const j = await res.json();
  assert.equal(j.leaderboard[0].handle, 'realdev'); // verified wins despite far fewer tokens
  assert.equal(j.leaderboard[0].rank, 1);
  assert.equal(j.leaderboard[1].handle, 'whale');
});

test('handleLeaderboard: score-based ranking is immune to low-sorting instanceId squatting', async () => {
  // Attacker mints 5 low-sorting IDs (all zeros → sorts before any real UUID).
  // Real user has high tokens but a later-sorting ID.
  const index = {};
  for (let i = 1; i <= 5; i++) {
    const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`;
    index[id] = { handle: `fake${i}`, verified: false, tokens: 0, sessions: 0, activeMs: 0, streak: 0, displayName: null, githubUser: null };
  }
  index['ffffffff-ffff-ffff-ffff-ffffffffffff'] = {
    handle: 'realuser', verified: false, tokens: 1_000_000, sessions: 50,
    activeMs: 100000, streak: 30, displayName: null, githubUser: null,
  };
  const env = makeEnv();
  await env.TOTALS.put('board:index', JSON.stringify(index));
  const res = await handleLeaderboard(new URL('http://localhost/leaderboard'), env);
  const j = await res.json();
  assert.equal(j.leaderboard[0].handle, 'realuser', 'real user ranks #1 regardless of key order');
  assert.equal(j.leaderboard[0].rank, 1);
});

test('handleLeaderboard: duplicate handles resolve to the authoritative handle: owner', async () => {
  // Regression for the non-atomic check-then-write race in handleProfile
  // (issue #13): both writers land in board:index with the same handle.
  const env = makeEnv();
  await env.TOTALS.put('board:index', JSON.stringify({
    '11111111-1111-1111-1111-111111111111': { handle: 'dupe', verified: false, tokens: 100, sessions: 1, activeMs: 0, streak: 0, displayName: null, githubUser: null },
    '22222222-2222-2222-2222-222222222222': { handle: 'dupe', verified: false, tokens: 999, sessions: 9, activeMs: 0, streak: 0, displayName: null, githubUser: null },
    '33333333-3333-3333-3333-333333333333': { handle: 'solo', verified: false, tokens: 5, sessions: 1, activeMs: 0, streak: 0, displayName: null, githubUser: null },
  }));
  // handle:<h> says instance 2222… owns 'dupe' (it wrote last).
  await env.TOTALS.put('handle:dupe', '22222222-2222-2222-2222-222222222222');
  const res = await handleLeaderboard(new URL('http://localhost/leaderboard'), env);
  const j = await res.json();
  const dupes = j.leaderboard.filter((r) => r.handle === 'dupe');
  assert.equal(dupes.length, 1, 'exactly one row for the contested handle');
  assert.equal(dupes[0].tokens, 999, 'the authoritative owner row survives');
  assert.ok(j.leaderboard.some((r) => r.handle === 'solo'), 'uncontested rows unaffected');
  assert.ok(!('updatedAt' in j.leaderboard[0]), 'index-internal fields not leaked');
});

test('handleLeaderboard: contested handle with an unresolvable owner pointer keeps one row (verified preferred)', async () => {
  // Regression: when handle:<h> resolves to an id absent from the index (a
  // lost/racy pointer write or a KV read miss), the old repair dropped EVERY
  // row for that handle. It must instead keep exactly one — the strongest
  // claim, verified first — so a contested handle never silently vanishes.
  const env = makeEnv();
  await env.TOTALS.put('board:index', JSON.stringify({
    '11111111-1111-1111-1111-111111111111': { handle: 'dupe', verified: false, tokens: 999, sessions: 9, activeMs: 0, streak: 0, displayName: null, githubUser: null },
    '22222222-2222-2222-2222-222222222222': { handle: 'dupe', verified: true,  tokens: 100, sessions: 1, activeMs: 0, streak: 0, displayName: null, githubUser: null },
  }));
  // Pointer references an id that isn't in the index at all.
  await env.TOTALS.put('handle:dupe', 'ffffffff-ffff-ffff-ffff-ffffffffffff');
  const res = await handleLeaderboard(new URL('http://localhost/leaderboard'), env);
  const j = await res.json();
  const dupes = j.leaderboard.filter((r) => r.handle === 'dupe');
  assert.equal(dupes.length, 1, 'contested handle still surfaces exactly one row, not zero');
  assert.equal(dupes[0].tokens, 100, 'verified claim is kept over the higher-token unverified one');
});

test('pruneBoardIndex: drops stale unverified entries, keeps verified and fresh ones', () => {
  const now = Date.now();
  const STALE = now - 91 * 24 * 60 * 60 * 1000; // older than the 90-day pf: TTL
  const index = {
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa': { handle: 'staleunv', verified: false, updatedAt: STALE },
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb': { handle: 'oldveri',  verified: true,  updatedAt: STALE },
    'cccccccc-cccc-cccc-cccc-cccccccccccc': { handle: 'freshunv', verified: false, updatedAt: now },
    'dddddddd-dddd-dddd-dddd-dddddddddddd': null, // corrupt entry → dropped
  };
  pruneBoardIndex(index, now);
  assert.deepEqual(Object.keys(index).sort(), [
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'cccccccc-cccc-cccc-cccc-cccccccccccc',
  ], 'stale unverified + corrupt entries pruned; verified and fresh kept');
});

test('handleProfile: write prunes stale unverified index entries (no unbounded bloat)', async () => {
  const env = makeEnv();
  const STALE = Date.now() - 91 * 24 * 60 * 60 * 1000;
  await env.TOTALS.put('board:index', JSON.stringify({
    '99999999-9999-9999-9999-999999999999': { handle: 'squatter', verified: false, tokens: 0, updatedAt: STALE },
  }));
  await handleProfile(profileRequest(profileBody), env);
  const index = JSON.parse(await env.TOTALS.get('board:index'));
  assert.ok(!index['99999999-9999-9999-9999-999999999999'], 'stale squatter entry pruned on write');
  assert.ok(index[profileBody.instanceId], 'new entry present');
  assert.ok(index[profileBody.instanceId].updatedAt > 0, 'entries carry updatedAt for future pruning');
});

test('handleProfile: updates board:index on each write', async () => {
  const env = makeEnv();
  await handleProfile(profileRequest(profileBody), env);
  const raw = await env.TOTALS.get('board:index');
  assert.ok(raw, 'board:index written');
  const index = JSON.parse(raw);
  assert.ok(index[profileBody.instanceId], 'entry for instanceId present');
  assert.equal(index[profileBody.instanceId].handle, 'archer');
  assert.equal(index[profileBody.instanceId].tokens, 1000);
  assert.equal(index[profileBody.instanceId].verified, false);
});

test('handleProfile: unverified pf: key gets a TTL; verified pf: key does not', async () => {
  const env = makeEnv();
  // Unverified write.
  await handleProfile(profileRequest(profileBody), env);
  const pfKey = `pf:${profileBody.instanceId}`;
  assert.ok(env.TOTALS.store.get(pfKey).ttl > 0, 'unverified profile has a TTL');

  // Verify the profile.
  await env.TOTALS.put(`verify:${profileBody.instanceId}`,
    JSON.stringify({ githubUser: 'octocat', token: 'vrf_ttltest', ts: Date.now() }));
  const fakeFetch = async (url) => {
    if (url.endsWith('/gists/def456')) {
      return { ok: true, json: async () => ({ owner: { login: 'octocat' }, files: { 'p.txt': { content: 'vrf_ttltest' } } }) };
    }
    return { ok: false };
  };
  const req = new Request('http://localhost/verify/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: profileBody.instanceId, gistId: 'def456' }),
  });
  await handleVerifyCheck(req, env, fakeFetch);
  assert.equal(env.TOTALS.store.get(pfKey).ttl, null, 'verified profile has no TTL');
});

test('handleVerifyCheck: updates board:index with verified=true', async () => {
  const env = makeEnv();
  await handleProfile(profileRequest(profileBody), env);
  await env.TOTALS.put(`verify:${profileBody.instanceId}`,
    JSON.stringify({ githubUser: 'octocat', token: 'vrf_idxtest', ts: Date.now() }));
  // gist ID must be hex only (safeGistId enforces /^[0-9a-f]{6,64}$/i).
  const fakeFetch = async (url) => {
    if (url.endsWith('/gists/abc789def012')) {
      return { ok: true, json: async () => ({ owner: { login: 'octocat' }, files: { 'p.txt': { content: 'vrf_idxtest' } } }) };
    }
    return { ok: false };
  };
  const req = new Request('http://localhost/verify/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: profileBody.instanceId, gistId: 'abc789def012' }),
  });
  await handleVerifyCheck(req, env, fakeFetch);
  const index = JSON.parse(await env.TOTALS.get('board:index'));
  assert.equal(index[profileBody.instanceId].verified, true, 'index reflects verified=true');
  assert.equal(index[profileBody.instanceId].githubUser, 'octocat');
});

test('handleVerifyStart: issues a vrf_ token for a valid github user', async () => {
  const env = makeEnv();
  const req = new Request('http://localhost/verify/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: profileBody.instanceId, githubUser: 'octocat' }),
  });
  const res = await handleVerifyStart(req, env);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.match(j.token, /^vrf_/);
});

test('handleVerifyCheck: verifies when the token appears in a public gist', async () => {
  const env = makeEnv();
  await env.TOTALS.put('pf:' + profileBody.instanceId,
    JSON.stringify({ handle: 'archer', verified: false, tokens: 1 }));
  await env.TOTALS.put('verify:' + profileBody.instanceId,
    JSON.stringify({ githubUser: 'octocat', token: 'vrf_abc123', ts: Date.now() }));
  const fakeFetch = async (url) => {
    if (url.includes('/gists')) {
      return { ok: true, json: async () => ([{ owner: { login: 'octocat' }, files: { 'a.txt': { raw_url: 'https://gist.githubusercontent.com/octocat/abc/raw/a.txt' } } }]) };
    }
    return { ok: true, text: async () => 'my proof token vrf_abc123 here' };
  };
  const req = new Request('http://localhost/verify/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: profileBody.instanceId }),
  });
  const res = await handleVerifyCheck(req, env, fakeFetch);
  const j = await res.json();
  assert.equal(j.verified, true);
  const prof = JSON.parse(env.TOTALS.store.get('pf:' + profileBody.instanceId).value);
  assert.equal(prof.verified, true);
});

test('handleVerifyCheck: instant via gistId, adopts the real gist owner', async () => {
  const env = makeEnv();
  await env.TOTALS.put('pf:' + profileBody.instanceId,
    JSON.stringify({ handle: 'archer', verified: false, tokens: 1 }));
  // pending has a WRONG github hint — the gist owner must win.
  await env.TOTALS.put('verify:' + profileBody.instanceId,
    JSON.stringify({ githubUser: 'wrongguess', token: 'vrf_xyz', ts: Date.now() }));
  const fakeFetch = async (url) => {
    if (url.endsWith('/gists/abc123')) {
      return { ok: true, json: async () => ({ owner: { login: 'RealOwner' }, files: { 'p.txt': { content: 'proof vrf_xyz here' } } }) };
    }
    return { ok: false };
  };
  const req = new Request('http://localhost/verify/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: profileBody.instanceId, gistId: 'abc123' }),
  });
  const res = await handleVerifyCheck(req, env, fakeFetch);
  const j = await res.json();
  assert.equal(j.verified, true);
  assert.equal(j.githubUser, 'RealOwner'); // adopted from the gist, not the wrong hint
  const prof = JSON.parse(env.TOTALS.store.get('pf:' + profileBody.instanceId).value);
  assert.equal(prof.githubUser, 'RealOwner');
});

test('handleVerifyCheck: 404 when no pending verification', async () => {
  const env = makeEnv();
  const req = new Request('http://localhost/verify/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: profileBody.instanceId }),
  });
  const res = await handleVerifyCheck(req, env, async () => ({ ok: false }));
  assert.equal(res.status, 404);
});

test('handleProfileGet: returns a public profile by handle, 404 if unknown', async () => {
  const env = makeEnv();
  await handleProfile(profileRequest(profileBody), env);
  const ok = await handleProfileGet(new URL('http://localhost/profile?handle=archer'), env);
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.profile.handle, 'archer');
  const miss = await handleProfileGet(new URL('http://localhost/profile?handle=nobody'), env);
  assert.equal(miss.status, 404);
});

// ── Per-endpoint rate scoping (the silent profile-flush 429) ─────────────

test('a /report does not rate-limit the same instance\'s /profile publish', async () => {
  // The daemon flushes community totals then the profile back-to-back with
  // one instanceId. A shared rate key meant the profile publish ALWAYS 429'd
  // whenever community had a delta.
  const env = makeEnv();
  const id = profileBody.instanceId;
  const r1 = await handleReport(reportRequest({ ...validBody, instanceId: id }), env);
  assert.equal(r1.status, 200);
  const r2 = await handleProfile(profileRequest({ ...profileBody, instanceId: id }), env);
  assert.equal(r2.status, 200, 'profile publish proceeds on its own rate key');
  // Each endpoint still limits itself.
  const r3 = await handleProfile(profileRequest({ ...profileBody, instanceId: id }), env);
  assert.equal(r3.status, 429, 'second profile publish within the window is limited');
});

// ── Orphaned-handle release (expired squatter) ───────────────────────────

test('an expired profile\'s handle is released to a new claimant', async () => {
  const env = makeEnv();
  const squatter = 'aaaaaaaa-0000-0000-0000-000000000001';
  const claimant = 'bbbbbbbb-0000-0000-0000-000000000002';
  let res = await handleProfile(profileRequest({ ...profileBody, instanceId: squatter }), env);
  assert.equal(res.status, 200);
  // Simulate the unverified pf: row's 90-day TTL firing (handle:<h> had no
  // TTL, so the mapping outlives the profile).
  env.TOTALS.store.delete('pf:' + squatter);
  res = await handleProfile(profileRequest({ ...profileBody, instanceId: claimant }), env);
  assert.equal(res.status, 200, 'orphaned handle is released, not 409');
  assert.equal(await env.TOTALS.get('handle:' + profileBody.handle), claimant);
});

test('a LIVE profile\'s handle still 409s for another instance', async () => {
  const env = makeEnv();
  const ownerId = 'aaaaaaaa-0000-0000-0000-000000000003';
  await handleProfile(profileRequest({ ...profileBody, instanceId: ownerId }), env);
  const res = await handleProfile(profileRequest(
    { ...profileBody, instanceId: 'bbbbbbbb-0000-0000-0000-000000000004' }), env);
  assert.equal(res.status, 409);
});

test('handleProfileGet: cleans up the orphaned handle mapping on 404', async () => {
  const env = makeEnv();
  const id = 'aaaaaaaa-0000-0000-0000-000000000005';
  await handleProfile(profileRequest({ ...profileBody, instanceId: id }), env);
  env.TOTALS.store.delete('pf:' + id); // simulate TTL expiry
  const url = new URL('http://localhost/profile?handle=' + profileBody.handle);
  const res = await handleProfileGet(url, env);
  assert.equal(res.status, 404);
  assert.equal(await env.TOTALS.get('handle:' + profileBody.handle), null, 'mapping dropped');
});

// ── mergeIntoCanonical hygiene (via /pair/claim) ──────────────────────

const { handlePairClaim } = await import('../src/index.js');

const UUID_N = 'aaaaaaaa-1111-2222-3333-444444444444';
const UUID_M = 'bbbbbbbb-1111-2222-3333-444444444444';
const UUID_C = 'cccccccc-1111-2222-3333-444444444444';

function pairClaimRequest(instanceId, code) {
  return new Request('http://localhost/pair/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId, code }),
  });
}

function seedPf(kv, id, over = {}) {
  kv.store.set(`pf:${id}`, { value: JSON.stringify({
    handle: over.handle, name: over.handle, verified: !!over.verified,
    githubUser: over.githubUser, tokens: over.tokens || 1000, sessions: 10,
    activeMs: 3_600_000, streak: 1, updatedAt: Date.now(),
    ...(over.machines ? { machines: over.machines } : {}),
  }), ttl: null });
}

test('pair/claim merge: a machine previously verified under another login releases its gh: mapping', async () => {
  const env = makeEnv();
  const kv = env.TOTALS;
  // Canonical C verified as alice; machine N previously verified as bob.
  seedPf(kv, UUID_C, { handle: 'alice', verified: true, githubUser: 'alice' });
  seedPf(kv, UUID_N, { handle: 'bobbox', verified: true, githubUser: 'bob' });
  kv.store.set('gh:alice', { value: UUID_C, ttl: null });
  kv.store.set('gh:bob', { value: UUID_N, ttl: null });
  kv.store.set('pair:TESTCD', { value: 'alice', ttl: 600 });

  const res = await handlePairClaim(pairClaimRequest(UUID_N, 'TESTCD'), env);
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get(`alias:${UUID_N}`), UUID_C, 'N aliased into C');
  assert.equal(await kv.get('gh:bob'), null, 'stale gh:bob mapping removed — bob no longer resolves into C');
  assert.equal(await kv.get('gh:alice'), UUID_C, 'alice still points at the canonical');
});

test('pair/claim merge: a canonical with member machines repoints their aliases and folds slices once', async () => {
  const env = makeEnv();
  const kv = env.TOTALS;
  seedPf(kv, UUID_C, { handle: 'alice', verified: true, githubUser: 'alice' });
  // N is itself a canonical: its own slice + member machine M's slice.
  seedPf(kv, UUID_N, {
    handle: 'oldteam', verified: true, githubUser: 'bob', tokens: 5000,
    machines: {
      [UUID_N]: { tokens: 3000, sessions: 6, activeMs: 1_000_000, streak: 1, updatedAt: Date.now() },
      [UUID_M]: { tokens: 2000, sessions: 4, activeMs: 500_000, streak: 1, updatedAt: Date.now() },
    },
  });
  kv.store.set('gh:alice', { value: UUID_C, ttl: null });
  kv.store.set(`alias:${UUID_M}`, { value: UUID_N, ttl: null });
  kv.store.set('pair:TESTCE', { value: 'alice', ttl: 600 });

  const res = await handlePairClaim(pairClaimRequest(UUID_N, 'TESTCE'), env);
  assert.equal(res.status, 200, await res.text());
  assert.equal(await kv.get(`alias:${UUID_M}`), UUID_C, 'member machine repointed to the new canonical');
  const merged = JSON.parse(await kv.get(`pf:${UUID_C}`));
  assert.equal(merged.machines[UUID_M].tokens, 2000, 'member slice folded individually');
  assert.equal(merged.machines[UUID_N].tokens, 3000, 'N contributes its OWN slice, not the double-counting profile sum');
  assert.equal(merged.tokens, 1000 + 3000 + 2000, 'recomputed total sums slices exactly once');
});

// ── Claude Wrapped ─────────────────────────────────────────────────────

const { validateWrapped, sanitizeWrapped, capBoardIndex,
  handleWrappedPublish, handleWrappedGet, handleWrappedCard } = await import('../src/index.js');

const wrappedBody = {
  instanceId: profileBody.instanceId,
  year: 2026,
  wrapped: {
    activeMs: 500 * 3_600_000, sessions: 420, tokens: 9_800_000_000, prompts: 5200,
    streakBest: 44, daysActive: 210, cachePct: 87, ships: 320, marathonPct: 12,
    topProjects: [{ name: 'claude-rpc', activeMs: 100 * 3_600_000 }],
    topLanguages: ['JavaScript', 'Rust'],
    topModels: [{ name: 'Opus 4.8', pct: 62 }],
    toolMix: [{ name: 'Read', pct: 40 }],
  },
};

function wrappedRequest(body) {
  return new Request('http://localhost/wrapped', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('validateWrapped: gates shape, uuid, and year range', () => {
  assert.equal(validateWrapped(wrappedBody), null);
  assert.match(validateWrapped({}), /instanceId/);
  assert.match(validateWrapped({ ...wrappedBody, year: 1999 }), /year/);
  assert.match(validateWrapped({ ...wrappedBody, year: '20x6' }), /year/);
  assert.match(validateWrapped({ ...wrappedBody, wrapped: null }), /wrapped/);
});

test('sanitizeWrapped: clamps values, caps arrays, drops unknown fields', () => {
  const dirty = sanitizeWrapped({
    tokens: 9e18,                       // beyond the 1T ceiling
    cachePct: 400,                      // beyond 100
    peakHour: 99,
    topProjects: Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, activeMs: 1000 })),
    topLanguages: ['js', '‮evil‬', ''],
    evil: 'must not survive',
    peakDay: { date: '2026-03-14', activeMs: 5 * 3_600_000 },
  });
  assert.equal(dirty.tokens, 1_000_000_000_000, 'token ceiling applied');
  assert.equal(dirty.cachePct, 100);
  assert.equal(dirty.peakHour, 23);
  assert.equal(dirty.topProjects.length, 5, 'project list capped');
  assert.deepEqual(dirty.topLanguages, [{ name: 'js', edits: 0 }, { name: 'evil', edits: 0 }],
    'v1.2.0 string form normalized to objects; bidi overrides stripped, empties dropped');
  const objLangs = sanitizeWrapped({ topLanguages: [{ name: 'Rust', edits: 12.9 }, { name: '', edits: 5 }] });
  assert.deepEqual(objLangs.topLanguages, [{ name: 'Rust', edits: 12 }], 'object form clamps + drops nameless');
  const extra = sanitizeWrapped({
    hotspot: { name: '../../etc/passwd', count: 42, daysSinceLastEdit: 3 },
    peakWeekday: { name: 'Tuesday', activeMs: 5 * 3_600_000 },
    streak: 7, daysSinceFirst: 400,
  });
  assert.equal(extra.hotspot.name, 'passwd', 'hotspot reduced to a basename');
  assert.equal(extra.hotspot.count, 42);
  assert.deepEqual(extra.peakWeekday, { name: 'Tuesday', activeMs: 5 * 3_600_000 });
  assert.equal(sanitizeWrapped({ peakWeekday: { name: 'Blursday', activeMs: 1 } }).peakWeekday, undefined, 'invalid weekday dropped');
  assert.equal(extra.streak, 7);
  assert.equal(extra.daysSinceFirst, 400);
  assert.equal('evil' in dirty, false, 'unknown fields dropped');
  assert.equal(dirty.peakDay.date, '2026-03-14');
  const noDay = sanitizeWrapped({ peakDay: { date: 'nope' } });
  assert.equal('peakDay' in noDay, false, 'malformed peakDay dropped');
});

test('wrapped: publish → get → svg round-trip (and 403 with no profile)', async () => {
  const env = makeEnv();

  // No published profile yet → publish refused.
  const early = await handleWrappedPublish(wrappedRequest(wrappedBody), env);
  assert.equal(early.status, 403);

  await handleProfile(profileRequest(profileBody), env);
  for (const k of [...env.TOTALS.store.keys()]) if (k.startsWith('rate:')) env.TOTALS.store.delete(k);

  const pub = await handleWrappedPublish(wrappedRequest(wrappedBody), env);
  const pubText = await pub.text();
  assert.equal(pub.status, 200, pubText);
  const pubBody = JSON.parse(pubText);
  assert.equal(pubBody.handle, 'archer');
  assert.match(pubBody.url, /\/wrapped\/archer\?year=2026$/);

  const got = await handleWrappedGet(new URL('http://localhost/wrapped?handle=archer&year=2026'), env);
  assert.equal(got.status, 200);
  const data = await got.json();
  assert.equal(data.year, 2026);
  assert.equal(data.wrapped.sessions, 420);
  assert.equal(data.wrapped.topProjects[0].name, 'claude-rpc');

  // No explicit year → falls back through current/previous year.
  const noYear = await handleWrappedGet(new URL('http://localhost/wrapped?handle=archer'), env);
  assert.equal(noYear.status, 200, 'year fallback finds the published record');

  const svg = await handleWrappedCard('archer', new URL('http://localhost/wrapped/archer.svg'), env);
  assert.equal(svg.status, 200);
  const svgText = await svg.text();
  assert.match(svgText, /Claude Wrapped 2026/);
  assert.match(svgText, /claude-rpc/, 'top project chip rendered');

  const ghost = await handleWrappedCard('ghost', new URL('http://localhost/wrapped/ghost.svg'), env);
  assert.equal(ghost.status, 200, 'unknown handle still returns an image');
  assert.match(await ghost.text(), /no wrapped published yet/);
});

test('capBoardIndex: evicts lowest-value unverified rows, never verified ones', () => {
  const index = {};
  for (let i = 0; i < 10; i++) {
    index[`u${i}`] = { handle: `u${i}`, verified: false, tokens: i * 100, updatedAt: Date.now() };
  }
  index.vip = { handle: 'vip', verified: true, tokens: 1, updatedAt: Date.now() };
  capBoardIndex(index, 5);
  assert.equal(Object.keys(index).length, 5);
  assert.ok(index.vip, 'verified row survives despite lowest tokens');
  assert.ok(index.u9 && index.u8, 'highest-value unverified rows survive');
  assert.equal(index.u0, undefined, 'lowest-value unverified evicted first');
  // Saturated with verified rows → cap stops evicting rather than culling real identities.
  const allVerified = Object.fromEntries(Array.from({ length: 6 }, (_, i) =>
    [`v${i}`, { handle: `v${i}`, verified: true, tokens: i, updatedAt: Date.now() }]));
  capBoardIndex(allVerified, 3);
  assert.equal(Object.keys(allVerified).length, 6, 'verified rows are never evicted');
});

test('pair/claim: a brand-new machine (no profile anywhere) gets its identity minted on the spot', async () => {
  // The `setup --link <code>` one-liner: fresh install, never published,
  // no canonical for the login. The claim must create a verified profile
  // (handle = login), not 409 with "publish a profile first".
  const env = makeEnv();
  const kv = env.TOTALS;
  const FRESH = 'dddddddd-1111-2222-3333-444444444444';
  kv.store.set('pair:TESTCF', { value: 'newbie', ttl: 600 });

  const res = await handlePairClaim(pairClaimRequest(FRESH, 'TESTCF'), env);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const body = JSON.parse(text);
  assert.equal(body.created, true);
  assert.equal(body.githubUser, 'newbie');
  assert.equal(body.handle, 'newbie');

  const prof = JSON.parse(await kv.get(`pf:${FRESH}`));
  assert.equal(prof.verified, true);
  assert.equal(prof.githubUser, 'newbie');
  assert.equal(prof.tokens, 0, 'totals start at zero until the first flush');
  assert.equal(await kv.get('handle:newbie'), FRESH);
  assert.equal(await kv.get('gh:newbie'), FRESH);
  assert.equal(await kv.get('pair:TESTCF'), null, 'code consumed');
  const index = JSON.parse(await kv.get('board:index'));
  assert.ok(index[FRESH], 'board row exists immediately');

  // Handle squatted by a LIVE unverified profile → suffixed handle, no theft.
  const FRESH2 = 'eeeeeeee-1111-2222-3333-444444444444';
  seedPf(kv, 'ffffffff-1111-2222-3333-444444444444', { handle: 'taken' });
  kv.store.set('handle:taken', { value: 'ffffffff-1111-2222-3333-444444444444', ttl: null });
  kv.store.set('pair:TESTCG', { value: 'taken', ttl: 600 });
  const res2 = await handlePairClaim(pairClaimRequest(FRESH2, 'TESTCG'), env);
  const text2 = await res2.text();
  assert.equal(res2.status, 200, text2);
  const body2 = JSON.parse(text2);
  assert.notEqual(body2.handle, 'taken');
  assert.match(body2.handle, /^taken-/, 'suffixed instead of stolen');
  assert.equal(await kv.get('handle:taken'), 'ffffffff-1111-2222-3333-444444444444', 'holder keeps the name');
});

// ── multi-machine wrapped (v2 records) ─────────────────────────────────

const { mergeWrappedSlices } = await import('../src/index.js');

test('mergeWrappedSlices: sums volume, maxes records, weights shares, merges names', () => {
  const dev = {
    activeMs: 80 * 3_600_000, sessions: 90, prompts: 1000, tokens: 900,
    linesAdded: 1000, linesRemoved: 100, ships: 200, costUsd: 100.5,
    streakBest: 18, daysActive: 28, cachePct: 90, marathonPct: 20,
    peakHour: 2, peakDay: { date: '2026-06-29', activeMs: 9 },
    hotspot: { name: 'cli.js', count: 154 },
    peakWeekday: { name: 'Monday', activeMs: 5 },
    topProjects: [{ name: 'claude-rpc', activeMs: 100 }],
    topLanguages: [{ name: 'JavaScript', edits: 2000 }],
    topModels: [{ name: 'Opus 4.8', pct: 70 }, { name: 'Fable 5', pct: 30 }],
    toolMix: [{ name: 'Read', pct: 50 }],
  };
  const laptop = {
    activeMs: 8 * 3_600_000, sessions: 10, prompts: 100, tokens: 100,
    linesAdded: 50, linesRemoved: 5, ships: 0, costUsd: 10.25,
    streakBest: 2, daysActive: 7, cachePct: 50, marathonPct: 0,
    peakHour: 20, peakDay: { date: '2026-05-01', activeMs: 3 },
    hotspot: { name: 'Settings.jsx', count: 24 },
    topProjects: [{ name: 'claude-rpc', activeMs: 20 }, { name: 'nib', activeMs: 10 }],
    topLanguages: [{ name: 'JavaScript', edits: 100 }, { name: 'Python', edits: 40 }],
    topModels: [{ name: 'Opus 4.8', pct: 100 }],
    toolMix: [{ name: 'Edit', pct: 60 }],
  };
  const m = mergeWrappedSlices({ a: dev, b: laptop });
  assert.equal(m.activeMs, 88 * 3_600_000, 'active time sums');
  assert.equal(m.sessions, 100);
  assert.equal(m.tokens, 1000);
  assert.equal(m.costUsd, 110.75);
  assert.equal(m.streakBest, 18, 'best streak is a MAX, not a sum');
  assert.equal(m.daysActive, 28, 'calendar days overlap — max, not sum');
  assert.equal(m.cachePct, Math.round((90 * 900 + 50 * 100) / 1000), 'cache% weighted by tokens');
  assert.equal(m.peakHour, 2, 'dominant machine owns the peak hour');
  assert.equal(m.peakDay.date, '2026-06-29', 'bigger peak day wins');
  assert.equal(m.hotspot.name, 'cli.js', 'hotter hotspot wins');
  assert.deepEqual(m.topProjects[0], { name: 'claude-rpc', activeMs: 120 }, 'same project sums across machines');
  assert.equal(m.topLanguages[0].edits, 2100);
  assert.equal(m.topModels[0].name, 'Opus 4.8');
  assert.equal(m.topModels[0].pct, 73, '70%×0.9 + 100%×0.1 = 73%');
  assert.equal(mergeWrappedSlices({ solo: dev }), dev, 'single slice passes through untouched');
});

test('wrapped v2: a second machine ADDS its slice instead of clobbering the year', async () => {
  const env = makeEnv();
  await handleProfile(profileRequest(profileBody), env);
  for (const k of [...env.TOTALS.store.keys()]) if (k.startsWith('rate:')) env.TOTALS.store.delete(k);

  // Machine A (the canonical) publishes a big year.
  await handleWrappedPublish(wrappedRequest(wrappedBody), env);
  // Machine B is an alias of A (a linked laptop) and publishes a small year.
  const LAPTOP = '99999999-8888-7777-6666-555555555555';
  env.TOTALS.store.set(`alias:${LAPTOP}`, { value: profileBody.instanceId, ttl: null });
  const small = { instanceId: LAPTOP, year: 2026, wrapped: { activeMs: 3_600_000, sessions: 10, tokens: 1000, prompts: 50 } };
  const res = await handleWrappedPublish(wrappedRequest(small), env);
  const pub = JSON.parse(await res.text());
  assert.equal(pub.machines, 2, 'two slices in the record');

  const got = await handleWrappedGet(new URL('http://localhost/wrapped?handle=archer&year=2026'), env);
  const data = await got.json();
  assert.equal(data.wrapped.sessions, 420 + 10, 'merged, not clobbered');
  assert.equal(data.wrapped.tokens, 9_800_000_000 + 1000);
  assert.equal(data.wrapped.machines, undefined, 'machines map never leaves the record');

  // A re-publish from the laptop replaces ONLY its own slice.
  for (const k of [...env.TOTALS.store.keys()]) if (k.startsWith('rate:')) env.TOTALS.store.delete(k);
  await handleWrappedPublish(wrappedRequest({ ...small, wrapped: { ...small.wrapped, sessions: 12 } }), env);
  const again = await (await handleWrappedGet(new URL('http://localhost/wrapped?handle=archer&year=2026'), env)).json();
  assert.equal(again.wrapped.sessions, 420 + 12, 'slice replaced, canonical slice intact');
});

// ── verifiedAt + resumed verification back-dating (1.4.3) ─────────────────
// The CLI daemon finishes verifications that died during the 2026-08-20 → 09-11
// KV write-cap outage; the stamp is back-dated to the user's consent.

const { verifiedAtFor } = await import('../src/index.js');

test('verifiedAtFor: now unless resumed; resumed back-dates within [createdAt − 2d, now]', () => {
  const DAY = 86_400_000;
  const now = 100 * DAY;
  const prof = { createdAt: 90 * DAY };
  assert.equal(verifiedAtFor(prof, {}, now), now);
  assert.equal(verifiedAtFor(prof, { pendingSince: 1 }, now), now, 'pendingSince ignored without resumed');
  assert.equal(verifiedAtFor(prof, { resumed: true }, now), 90 * DAY, 'undated resume anchors on createdAt');
  assert.equal(verifiedAtFor(prof, { resumed: true, pendingSince: 89.5 * DAY }, now), 89.5 * DAY, 'consent a day before the first landed write');
  assert.equal(verifiedAtFor(prof, { resumed: true, pendingSince: 10 * DAY }, now), 88 * DAY, 'clamped to createdAt − 2d');
  assert.equal(verifiedAtFor(prof, { resumed: true, pendingSince: 200 * DAY }, now), now, 'never in the future');
  assert.equal(verifiedAtFor(prof, { resumed: true, pendingSince: '5' }, now), 90 * DAY, 'non-numbers ignored');
  assert.equal(verifiedAtFor({}, { resumed: true }, now), now, 'no createdAt → now');
});

async function verifyWithGist(env, extraBody) {
  await env.TOTALS.put(`verify:${profileBody.instanceId}`,
    JSON.stringify({ githubUser: 'octocat', token: 'vrf_resume', ts: Date.now() }));
  const fakeFetch = async (url) => (url.endsWith('/gists/feed42')
    ? { ok: true, json: async () => ({ owner: { login: 'octocat' }, files: { 'p.txt': { content: 'vrf_resume' } } }) }
    : { ok: false });
  const req = new Request('http://localhost/verify/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instanceId: profileBody.instanceId, gistId: 'feed42', ...extraBody }),
  });
  return handleVerifyCheck(req, env, fakeFetch);
}

test('handleVerifyCheck: resumed verify back-dates verifiedAt and createdAt; survives the next flush', async () => {
  const env = makeEnv();
  await handleProfile(profileRequest(profileBody), env);
  const pfKey = `pf:${profileBody.instanceId}`;
  const created = JSON.parse(env.TOTALS.store.get(pfKey).value).createdAt;
  const consent = created - 6 * 3_600_000; // said "y" six hours before the first write landed

  const res = await verifyWithGist(env, { resumed: true, pendingSince: consent });
  assert.equal((await res.json()).verified, true);
  let prof = JSON.parse(env.TOTALS.store.get(pfKey).value);
  assert.equal(prof.verifiedAt, consent);
  assert.equal(prof.createdAt, consent, 'join date moves to the consent');

  // The daemon's next /profile flush must not erase the stamp.
  await handleProfile(profileRequest({ ...profileBody, tokens: 2000 }), env);
  prof = JSON.parse(env.TOTALS.store.get(pfKey).value);
  assert.equal(prof.verifiedAt, consent);
  assert.equal(prof.createdAt, consent);
  assert.equal(prof.verified, true);
});

test('handleVerifyCheck: ordinary verify stamps now and leaves createdAt alone', async () => {
  const env = makeEnv();
  await handleProfile(profileRequest(profileBody), env);
  const pfKey = `pf:${profileBody.instanceId}`;
  const created = JSON.parse(env.TOTALS.store.get(pfKey).value).createdAt;
  const before = Date.now();
  await verifyWithGist(env, { pendingSince: 1 }); // no `resumed` → ignored
  const prof = JSON.parse(env.TOTALS.store.get(pfKey).value);
  assert.ok(prof.verifiedAt >= before);
  assert.equal(prof.createdAt, created);
});

test('handleVerifyCheck: re-verifying keeps the original verifiedAt', async () => {
  const env = makeEnv();
  await handleProfile(profileRequest(profileBody), env);
  const pfKey = `pf:${profileBody.instanceId}`;
  await verifyWithGist(env, {});
  const first = JSON.parse(env.TOTALS.store.get(pfKey).value).verifiedAt;
  await verifyWithGist(env, { resumed: true, pendingSince: first - 86_400_000 });
  assert.equal(JSON.parse(env.TOTALS.store.get(pfKey).value).verifiedAt, first);
});

// ── heatmap: daily series storage + /heatmap and /stats SVGs ──────────────

const { sanitizeDaily, profileSeries, handleUserHeatmap, handleUserStats } = await import('../src/index.js');

function dayAgo(n, now = Date.now()) { return new Date(now - n * 86_400_000).toISOString().slice(0, 10); }
function clearRates(env) { for (const k of [...env.TOTALS.store.keys()]) if (k.startsWith('rate:')) env.TOTALS.store.delete(k); }
async function storedProfile(env, id) { return JSON.parse(await env.TOTALS.get(`pf:${id}`)); }

test('sanitizeDaily: clamps values, trims to a year, drops junk instead of rejecting', () => {
  const now = Date.now();
  const d = sanitizeDaily({ end: dayAgo(0, now), tokens: [-5, 'x', 1e15, 7], activeMin: [5000, 3] }, now);
  assert.deepEqual(d.tokens, [0, 0, 100_000_000_000, 7]);
  assert.deepEqual(d.activeMin, [1440, 3]);
  assert.equal(sanitizeDaily({ end: dayAgo(0, now), tokens: new Array(900).fill(1) }, now).tokens.length, 371);
  assert.equal(sanitizeDaily({ end: '2026-02-30', tokens: [1] }, now), null);
  assert.equal(sanitizeDaily({ end: dayAgo(-5, now), tokens: [1] }, now), null, 'future end');
  assert.equal(sanitizeDaily({ end: dayAgo(500, now), tokens: [1] }, now), null, 'ancient end');
  assert.equal(sanitizeDaily('nope', now), null);
  // a junk series never blocks the profile itself
  assert.equal(validateProfile({ ...profileBody, daily: { end: 'x' } }), null);
});

test('handleProfile: stores daily per machine; older clients keep it; null clears it', async () => {
  const env = makeEnv();
  const id = profileBody.instanceId;
  await handleProfile(profileRequest({ ...profileBody, daily: { end: dayAgo(0), tokens: [1, 2], activeMin: [3, 4] } }), env);
  let p = await storedProfile(env, id);
  assert.deepEqual(p.machines[id].daily.tokens, [1, 2]);
  // an older client (no `daily` field) must not erase the series
  clearRates(env);
  await handleProfile(profileRequest(profileBody), env);
  p = await storedProfile(env, id);
  assert.deepEqual(p.machines[id].daily.tokens, [1, 2]);
  // opting out sends daily: null → cleared
  clearRates(env);
  await handleProfile(profileRequest({ ...profileBody, daily: null }), env);
  p = await storedProfile(env, id);
  assert.equal(p.machines[id].daily, undefined);
  // and the public profile shape never carries the series
  const pub = await (await handleProfileGet(new URL('http://localhost/profile?handle=archer'), env)).json();
  assert.equal(pub.profile.daily, undefined);
  assert.equal(pub.profile.machines, undefined);
});

test('profileSeries: a linked laptop\'s days are summed into the canonical heatmap', async () => {
  const env = makeEnv();
  const LAPTOP = '99999999-8888-7777-6666-555555555555';
  await handleProfile(profileRequest({ ...profileBody, daily: { end: dayAgo(0), tokens: [10, 20], activeMin: [1, 2] } }), env);
  env.TOTALS.store.set(`alias:${LAPTOP}`, { value: profileBody.instanceId, ttl: null });
  // laptop last synced yesterday: its last value lands one day earlier
  await handleProfile(profileRequest({ ...profileBody, instanceId: LAPTOP, daily: { end: dayAgo(1), tokens: [100], activeMin: [5] } }), env);
  const s = profileSeries(await storedProfile(env, profileBody.instanceId));
  assert.equal(s.end, dayAgo(0));
  assert.deepEqual(s.tokens.slice(-2), [110, 20]);
  assert.deepEqual(s.activeMin.slice(-2), [6, 2]);
});

test('/heatmap and /stats: render from the stored series, placeholder otherwise', async () => {
  const env = makeEnv();
  await handleProfile(profileRequest({ ...profileBody, daily: { end: dayAgo(0), tokens: [5_000_000, 9], activeMin: [60, 0] } }), env);
  const res = await worker.fetch(new Request('http://localhost/heatmap/archer.svg?metric=hours'), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /svg/);
  const body = await res.text();
  assert.match(body, /Archer · a year on Claude Code/);
  assert.match(body, /1 active days/);
  const stats = await (await worker.fetch(new Request('http://localhost/stats/archer.svg'), env)).text();
  assert.match(stats, /BUSIEST DAY/);
  assert.match(stats, /5\.00M/);
  assert.doesNotMatch(stats, /aaaaaaaa-bbbb/, 'never leaks an instanceId');
  // unknown handle / no series yet: still an SVG, with a hint, short cache
  const none = await handleUserHeatmap('nobody', new URL('http://localhost/heatmap/nobody.svg'), env);
  assert.match(await none.text(), /no public profile yet/);
  assert.match(none.headers.get('Cache-Control'), /max-age=60/);
  const env2 = makeEnv();
  await handleProfile(profileRequest(profileBody), env2);
  const pending = await handleUserStats('archer', new URL('http://localhost/stats/archer.svg'), env2);
  assert.match(await pending.text(), /after the next profile sync/);
});
