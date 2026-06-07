// Unit tests for the worker's route handlers. We don't run wrangler dev
// here — instead we exercise the exported handler functions directly
// against an in-memory KV stub that mimics the binding's surface
// (`get`, `put` with `expirationTtl`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validateReport, handleReport, handleBadge, handleJson, handleRef, handleRefs,
  validateProfile, handleProfile, handleLeaderboard, handleVerifyStart, handleVerifyCheck,
  handleProfileGet } = await import('../src/index.js');
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
  const total = await env.TOTALS.get('total:sessions');
  assert.equal(total, '2');
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
  env.TOTALS.store.delete('rate:' + profileBody.instanceId);
  res = await handleProfile(profileRequest({ ...profileBody, tokens: 2000, sessions: 9 }), env);
  j = await res.json();
  assert.equal(j.profile.tokens, 2000);
  assert.equal(j.profile.sessions, 9);
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
      return { ok: true, json: async () => ([{ files: { 'a.txt': { raw_url: 'https://raw/x' } } }]) };
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
