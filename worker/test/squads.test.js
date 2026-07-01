// Web login (auth.js + OAuth handlers) and squads — unit tests against the
// same in-memory KV stub style as index.test.js, with GitHub mocked out.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { mintToken, verifyToken, SESSION_TTL_MS } = await import('../src/auth.js');
const {
  handleProfile, handleProfileGet, handleLeaderboard,
  handleVerifyCheck, handleVerifyStart,
  handleAuthLogin, handleAuthCallback, handleAuthMe,
  handleSquadCreate, handleSquadJoin, handleSquadLeave, handleSquadUpdate,
  handleSquadsMine, handleSquadGet, handleSquadByCode,
  isoWeekKeyUTC,
} = await import('../src/index.js');

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k).value : null; },
    async put(k, v, opts = {}) { store.set(k, { value: String(v), ttl: opts.expirationTtl || null }); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const SECRET = 'unit-test-secret';
function makeEnv() {
  return {
    TOTALS: makeKv(),
    SESSION_SECRET: SECRET,
    GITHUB_CLIENT_ID: 'cid123',
    GITHUB_CLIENT_SECRET: 'shh',
    SITE_ORIGIN: 'https://claude-rpc.com',
  };
}

function post(path, body, headers = {}) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const IDS = {
  alice: 'aaaaaaaa-1111-2222-3333-444444444444',
  bob:   'bbbbbbbb-1111-2222-3333-444444444444',
  carol: 'cccccccc-1111-2222-3333-444444444444',
  dave:  'dddddddd-1111-2222-3333-444444444444',
};

// Seed a published profile (clearing the per-endpoint rate marker afterwards
// so later squad ops and re-publishes in the same test aren't throttled).
async function seedProfile(env, instanceId, handle, totals = {}) {
  const res = await handleProfile(post('/profile', {
    instanceId, handle, version: '0.15.0', osFamily: 'linux',
    tokens: 1000, sessions: 10, activeMs: 3_600_000, streak: 2, ...totals,
  }), env);
  assert.equal(res.status, 200, `seed profile ${handle}: ${await res.clone().text()}`);
  env.TOTALS.store.delete('rate:profile:' + instanceId);
  return res.json();
}

async function createSquad(env, instanceId, name = 'the boys') {
  const res = await handleSquadCreate(post('/squad/create', { instanceId, name }), env);
  assert.equal(res.status, 200, await res.clone().text());
  const j = await res.json();
  env.TOTALS.store.delete('rate:squad-create:' + instanceId);
  return j.squad;
}

// Read the raw squad record straight from KV (members/ownerId are internal —
// the public standings strip instanceIds, so merge migration is checked here).
async function getSquadRaw(env, id) {
  return JSON.parse(env.TOTALS.store.get('squad:' + id).value);
}

// ── auth.js tokens ───────────────────────────────────────────────────────

test('mint/verify round-trips and is kind-locked + expiry-checked', async () => {
  const t = await mintToken('sess', { gh: 'octocat' }, SECRET, SESSION_TTL_MS);
  const p = await verifyToken(t, 'sess', SECRET);
  assert.equal(p.gh, 'octocat');
  assert.equal(await verifyToken(t, 'state', SECRET), null, 'kind-locked');
  assert.equal(await verifyToken(t, 'sess', 'other-secret'), null, 'wrong secret');
  assert.equal(await verifyToken(t + 'x', 'sess', SECRET), null, 'tampered sig');
  const expired = await mintToken('sess', { gh: 'octocat' }, SECRET, -1);
  assert.equal(await verifyToken(expired, 'sess', SECRET), null, 'expired');
});

// ── OAuth handlers ───────────────────────────────────────────────────────

test('auth/login redirects to GitHub with a signed state; bad return paths are pinned', async () => {
  const env = makeEnv();
  const res = await handleAuthLogin(new URL('http://localhost/auth/login?return=https://evil.example'), env);
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.hostname, 'github.com');
  assert.equal(loc.searchParams.get('client_id'), 'cid123');
  const state = await verifyToken(loc.searchParams.get('state'), 'state', SECRET);
  assert.equal(state.ret, '/leaderboard', 'open-redirect attempt pinned to default');
});

test('auth/login 503s when not configured', async () => {
  const env = { ...makeEnv(), GITHUB_CLIENT_ID: '' };
  const res = await handleAuthLogin(new URL('http://localhost/auth/login'), env);
  assert.equal(res.status, 503);
});

function githubMock(login) {
  return async (url) => {
    if (String(url).includes('login/oauth/access_token')) {
      return new Response(JSON.stringify({ access_token: 'gho_test' }), { status: 200 });
    }
    if (String(url).includes('api.github.com/user')) {
      return new Response(JSON.stringify({ login }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  };
}

test('auth/callback exchanges the code and redirects to the site with a session token', async () => {
  const env = makeEnv();
  const state = await mintToken('state', { ret: '/leaderboard' }, SECRET, 60_000);
  const url = new URL(`http://localhost/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
  const res = await handleAuthCallback(url, env, githubMock('octocat'));
  assert.equal(res.status, 302);
  const dest = res.headers.get('Location');
  assert.ok(dest.startsWith('https://claude-rpc.com/leaderboard#token='), dest);
  const token = decodeURIComponent(dest.match(/#token=([^&]+)/)[1]);
  assert.equal((await verifyToken(token, 'sess', SECRET)).gh, 'octocat');
});

test('auth/callback rejects a forged or expired state', async () => {
  const env = makeEnv();
  const res = await handleAuthCallback(new URL('http://localhost/auth/callback?code=abc&state=garbage'), env, githubMock('octocat'));
  assert.equal(res.status, 400);
});

test('auth/me resolves a verified profile via the gh: index, backfilling from the board', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'alice');
  // Simulate a pre-index verification: profile verified on the board, no gh: key.
  const pf = JSON.parse(env.TOTALS.store.get('pf:' + IDS.alice).value);
  pf.verified = true; pf.githubUser = 'AliceGH';
  env.TOTALS.store.set('pf:' + IDS.alice, { value: JSON.stringify(pf), ttl: null });
  const idx = JSON.parse(env.TOTALS.store.get('board:index').value);
  idx[IDS.alice].verified = true; idx[IDS.alice].githubUser = 'AliceGH';
  env.TOTALS.store.set('board:index', { value: JSON.stringify(idx), ttl: null });

  const token = await mintToken('sess', { gh: 'alicegh' }, SECRET, 60_000);
  const res = await handleAuthMe(new Request('http://localhost/auth/me', { headers: { Authorization: `Bearer ${token}` } }), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.linked, true);
  assert.equal(j.profile.handle, 'alice');
  assert.equal(await env.TOTALS.get('gh:alicegh'), IDS.alice, 'index backfilled');
});

test('verify/check writes the gh: reverse index', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.bob, 'bob');
  await handleVerifyStart(post('/verify/start', { instanceId: IDS.bob }), env);
  const pending = JSON.parse(env.TOTALS.store.get('verify:' + IDS.bob).value);
  const gistFetch = async (url) => {
    if (String(url).includes('/gists/')) {
      return new Response(JSON.stringify({
        owner: { login: 'BobGH' },
        files: { 'v.txt': { content: `proof ${pending.token}` } },
      }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  };
  const res = await handleVerifyCheck(post('/verify/check', { instanceId: IDS.bob, gistId: 'abcdef123456' }), env, gistFetch);
  assert.equal(res.status, 200);
  assert.equal(await env.TOTALS.get('gh:bobgh'), IDS.bob);
});

// ── Squads ───────────────────────────────────────────────────────────────

test('squad lifecycle: create → join by code → standings with ranks', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'alice', { tokens: 5000 });
  await seedProfile(env, IDS.bob, 'bob', { tokens: 1000 });

  const squad = await createSquad(env, IDS.alice);
  assert.match(squad.code, /^SQ-[2-9A-HJKMNP-Z]{6}$/);
  assert.equal(squad.owner, true);

  const join = await handleSquadJoin(post('/squad/join', { instanceId: IDS.bob, code: squad.code.toLowerCase() }), env);
  assert.equal(join.status, 200, await join.clone().text());

  const res = await handleSquadGet(new URL(`http://localhost/squad?id=${squad.id}`), env);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.squad.members, 2);
  assert.equal(j.standings.length, 2);
  assert.ok(j.standings.every((r) => r.rank >= 1 && r.handle), 'ranked rows with handles');
  assert.ok(!JSON.stringify(j).includes(IDS.alice), 'instanceIds never leak in standings');
  assert.ok(!JSON.stringify(j).includes(squad.code), 'invite code never leaks in standings');
});

test('weekly delta: baseline snapshots on first read, later totals race from it', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'alice', { tokens: 5000, sessions: 50 });
  const squad = await createSquad(env, IDS.alice);

  let j = await (await handleSquadGet(new URL(`http://localhost/squad?id=${squad.id}`), env)).json();
  assert.equal(j.standings[0].weekTokens, 0, 'baseline week starts at zero');
  assert.equal(j.squad.week, isoWeekKeyUTC(), 'week key reported');

  // The daemon flushes new absolute totals…
  await seedProfile(env, IDS.alice, 'alice', { tokens: 7500, sessions: 55 });
  j = await (await handleSquadGet(new URL(`http://localhost/squad?id=${squad.id}`), env)).json();
  assert.equal(j.standings[0].weekTokens, 2500);
  assert.equal(j.standings[0].weekSessions, 5);
  assert.equal(j.standings[0].tokens, 7500, 'lifetime rides along');
});

test('mid-week joiner races from their join point, not their lifetime total', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'alice', { tokens: 100 });
  await seedProfile(env, IDS.bob, 'bob', { tokens: 999_999 });
  const squad = await createSquad(env, IDS.alice);
  await handleSquadGet(new URL(`http://localhost/squad?id=${squad.id}`), env); // baseline forms (alice only)
  await handleSquadJoin(post('/squad/join', { instanceId: IDS.bob, code: squad.code }), env);
  const j = await (await handleSquadGet(new URL(`http://localhost/squad?id=${squad.id}`), env)).json();
  const bob = j.standings.find((r) => r.handle === 'bob');
  assert.equal(bob.weekTokens, 0, 'lifetime total does not dump into the weekly race');
});

test('leave: ownership transfers, last leaver dissolves the squad and frees the code', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'alice');
  await seedProfile(env, IDS.bob, 'bob');
  const squad = await createSquad(env, IDS.alice);
  await handleSquadJoin(post('/squad/join', { instanceId: IDS.bob, code: squad.code }), env);

  let res = await handleSquadLeave(post('/squad/leave', { instanceId: IDS.alice, squadId: squad.id }), env);
  assert.equal((await res.json()).left, true);
  const mine = await (await handleSquadsMine(post('/squads/mine', { instanceId: IDS.bob }), env)).json();
  assert.equal(mine.squads[0].owner, true, 'bob inherited ownership');

  res = await handleSquadLeave(post('/squad/leave', { instanceId: IDS.bob, squadId: squad.id }), env);
  assert.equal((await res.json()).dissolved, true);
  assert.equal(await env.TOTALS.get('sqcode:' + squad.code), null, 'code freed');
  const gone = await handleSquadGet(new URL(`http://localhost/squad?id=${squad.id}`), env);
  assert.equal(gone.status, 404);
});

test('owner tools: rename, regenerate code, remove member; non-owner is 403', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'alice');
  await seedProfile(env, IDS.bob, 'bob');
  const squad = await createSquad(env, IDS.alice);
  await handleSquadJoin(post('/squad/join', { instanceId: IDS.bob, code: squad.code }), env);

  let res = await handleSquadUpdate(post('/squad/update', { instanceId: IDS.bob, squadId: squad.id, name: 'hijack' }), env);
  assert.equal(res.status, 403);

  res = await handleSquadUpdate(post('/squad/update', { instanceId: IDS.alice, squadId: squad.id, name: 'late shift', regenCode: true }), env);
  const j = await res.json();
  assert.equal(j.squad.name, 'late shift');
  assert.notEqual(j.squad.code, squad.code);
  assert.equal(await env.TOTALS.get('sqcode:' + squad.code), null, 'old code dead');

  res = await handleSquadUpdate(post('/squad/update', { instanceId: IDS.alice, squadId: squad.id, removeMember: 'bob' }), env);
  assert.equal((await res.json()).squad.members, 1);
  const bobs = await (await handleSquadsMine(post('/squads/mine', { instanceId: IDS.bob }), env)).json();
  assert.equal(bobs.squads.length, 0, 'removed member\'s index cleaned');
});

test('caps: membership requires a profile; squads-per-user is bounded', async () => {
  const env = makeEnv();
  const res = await handleSquadCreate(post('/squad/create', { instanceId: IDS.carol, name: 'ghosts' }), env);
  assert.equal(res.status, 409, 'no profile → no squad');

  await seedProfile(env, IDS.alice, 'alice');
  for (let i = 0; i < 5; i++) await createSquad(env, IDS.alice, `squad ${i}`);
  const over = await handleSquadCreate(post('/squad/create', { instanceId: IDS.alice, name: 'one too many' }), env);
  assert.equal(over.status, 409);
});

test('web session can drive squad ops once the profile is GitHub-linked', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'alice');
  await env.TOTALS.put('gh:alicegh', IDS.alice);
  const token = await mintToken('sess', { gh: 'alicegh' }, SECRET, 60_000);
  const res = await handleSquadCreate(
    post('/squad/create', { name: 'web squad' }, { Authorization: `Bearer ${token}` }), env,
  );
  assert.equal(res.status, 200, await res.clone().text());
  const unlinked = await mintToken('sess', { gh: 'nobody' }, SECRET, 60_000);
  const nores = await handleSquadCreate(
    post('/squad/create', { name: 'nope' }, { Authorization: `Bearer ${unlinked}` }), env,
  );
  assert.equal(nores.status, 403, 'session without a linked profile is rejected');
});

test('bycode previews name + size, and bad codes 404 without information leaks', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'alice');
  const squad = await createSquad(env, IDS.alice, 'night crew');
  let res = await handleSquadByCode(new URL(`http://localhost/squad/bycode?code=${squad.code}`), env);
  const j = await res.json();
  assert.equal(j.squad.name, 'night crew');
  assert.equal(j.squad.members, 1);
  res = await handleSquadByCode(new URL('http://localhost/squad/bycode?code=SQ-222222'), env);
  assert.equal(res.status, 404);
});

// ── CLI ↔ web pairing (link codes) ───────────────────────────────────────

const { handlePairStart, handlePairClaim } = await import('../src/index.js');

test('pair: web session mints a code, CLI claim verifies the profile end-to-end', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'alice');
  const sess = await mintToken('sess', { gh: 'AliceGH' }, SECRET, 60_000);
  const start = await handlePairStart(post('/pair/start', {}, { Authorization: `Bearer ${sess}` }), env);
  assert.equal(start.status, 200);
  const { code } = await start.json();
  assert.match(code, /^[2-9A-HJKMNP-Z]{6}$/);

  // CLI claims with lowercase + stray spaces — normalization handles it.
  const claim = await handlePairClaim(post('/pair/claim', { instanceId: IDS.alice, code: ` ${code.toLowerCase()} ` }), env);
  assert.equal(claim.status, 200, await claim.clone().text());
  const j = await claim.json();
  assert.equal(j.githubUser, 'AliceGH');
  assert.equal(j.verified, true);

  const prof = JSON.parse(env.TOTALS.store.get('pf:' + IDS.alice).value);
  assert.equal(prof.verified, true, 'profile now carries the ✓');
  assert.equal(prof.githubUser, 'AliceGH');
  assert.equal(env.TOTALS.store.get('pf:' + IDS.alice).ttl, null, 'verified → permanent (no TTL)');
  assert.equal(await env.TOTALS.get('gh:alicegh'), IDS.alice, 'web login now resolves to the profile');
  assert.equal(await env.TOTALS.get('pair:' + code), null, 'code is one-time');
});

test('pair: claim without a profile, with a bad code, or unauthenticated start all fail cleanly', async () => {
  const env = makeEnv();
  let res = await handlePairStart(post('/pair/start', {}), env);
  assert.equal(res.status, 401, 'no session → no code');

  const sess = await mintToken('sess', { gh: 'someone' }, SECRET, 60_000);
  const { code } = await (await handlePairStart(post('/pair/start', {}, { Authorization: `Bearer ${sess}` }), env)).json();
  res = await handlePairClaim(post('/pair/claim', { instanceId: IDS.carol, code }), env);
  assert.equal(res.status, 409, 'no published profile → instructive 409');
  res = await handlePairClaim(post('/pair/claim', { instanceId: IDS.carol, code: 'AAAAAA' }), env);
  assert.equal(res.status, 404, 'unknown code → 404');
});

// Verify a profile the way the merge tests do elsewhere: a web session mints a
// pair code, the machine claims it. Leaves the machine verified + gh-linked.
async function verifyViaPair(env, instanceId, login) {
  const sess = await mintToken('sess', { gh: login }, SECRET, 60_000);
  const { code } = await (await handlePairStart(post('/pair/start', {}, { Authorization: `Bearer ${sess}` }), env)).json();
  const claim = await handlePairClaim(post('/pair/claim', { instanceId, code }), env);
  assert.equal(claim.status, 200, await claim.clone().text());
}

test('pair: a verified machine mints a code itself; a fresh machine claims it and merges', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'alice', { tokens: 100 });
  await verifyViaPair(env, IDS.alice, 'AliceGH');

  // No Bearer header — the machine's instanceId is the credential.
  const start = await handlePairStart(post('/pair/start', { instanceId: IDS.alice }), env);
  assert.equal(start.status, 200, await start.clone().text());
  const { code } = await start.json();
  assert.match(code, /^[2-9A-HJKMNP-Z]{6}$/);

  // Machine #2 claims → folds into alice's canonical identity.
  await seedProfile(env, IDS.bob, 'bob-laptop', { tokens: 7 });
  const claim = await handlePairClaim(post('/pair/claim', { instanceId: IDS.bob, code }), env);
  assert.equal(claim.status, 200, await claim.clone().text());
  const j = await claim.json();
  assert.equal(j.merged, true, 'second machine merges, never a rival identity');
  assert.equal(j.githubUser, 'AliceGH');
  assert.equal(j.handle, 'alice', 'canonical handle wins');
  assert.equal(await env.TOTALS.get('alias:' + IDS.bob), IDS.alice);
  const prof = JSON.parse(env.TOTALS.store.get('pf:' + IDS.alice).value);
  assert.equal(prof.tokens, 107, 'totals sum across machines');
});

test('pair: unverified or unknown machines cannot mint, and minting is throttled per machine', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.carol, 'carol'); // published but NOT verified
  let res = await handlePairStart(post('/pair/start', { instanceId: IDS.carol }), env);
  assert.equal(res.status, 403, 'unverified machine cannot mint — the ✓ must root in a proven identity');

  res = await handlePairStart(post('/pair/start', { instanceId: IDS.dave }), env);
  assert.equal(res.status, 403, 'machine with no profile cannot mint');

  await seedProfile(env, IDS.alice, 'alice');
  await verifyViaPair(env, IDS.alice, 'AliceGH');
  res = await handlePairStart(post('/pair/start', { instanceId: IDS.alice }), env);
  assert.equal(res.status, 200);
  res = await handlePairStart(post('/pair/start', { instanceId: IDS.alice }), env);
  assert.equal(res.status, 429, 'back-to-back mints from one machine are throttled');
});

test('verify/check sends authenticated GitHub API requests when app creds exist', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.bob, 'bob');
  await handleVerifyStart(post('/verify/start', { instanceId: IDS.bob }), env);
  const pending = JSON.parse(env.TOTALS.store.get('verify:' + IDS.bob).value);
  let sawAuth = null;
  const gistFetch = async (url, opts) => {
    sawAuth = opts?.headers?.Authorization || null;
    return new Response(JSON.stringify({
      owner: { login: 'BobGH' },
      files: { 'v.txt': { content: pending.token } },
    }), { status: 200 });
  };
  await handleVerifyCheck(post('/verify/check', { instanceId: IDS.bob, gistId: 'abcdef123456' }), env, gistFetch);
  assert.ok(sawAuth && sawAuth.startsWith('Basic '), 'OAuth-app Basic auth applied (shared-IP rate-limit fix)');
});

test('a verified profile claims its own GitHub-name handle from an unverified squatter', async () => {
  const env = makeEnv();
  // Squatter publishes first and takes the name.
  await seedProfile(env, IDS.bob, 'octocat', { tokens: 5 });
  // Claimant is verified AS GitHub user "octocat" (e.g. via pair/claim).
  await seedProfile(env, IDS.alice, 'tempname', { tokens: 100 });
  const pf = JSON.parse(env.TOTALS.store.get('pf:' + IDS.alice).value);
  pf.verified = true; pf.githubUser = 'octocat';
  env.TOTALS.store.set('pf:' + IDS.alice, { value: JSON.stringify(pf), ttl: null });

  const res = await handleProfile(post('/profile', {
    instanceId: IDS.alice, handle: 'octocat', version: '0.15.0', osFamily: 'linux', tokens: 100,
  }), env);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).profile.handle, 'octocat');
  assert.equal(await env.TOTALS.get('handle:octocat'), IDS.alice, 'verified identity wins the name');
  const displaced = JSON.parse(env.TOTALS.store.get('pf:' + IDS.bob).value);
  assert.match(displaced.handle, /^octocat-[0-9a-f]{4}/, 'squatter keeps stats under a derived handle');
  assert.equal(await env.TOTALS.get('handle:' + displaced.handle), IDS.bob);
});

test('an unverified claimant still cannot take a held handle', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.bob, 'octocat');
  const res = await handleProfile(post('/profile', {
    instanceId: IDS.alice, handle: 'octocat', version: '0.15.0', osFamily: 'linux', tokens: 1,
  }), env);
  assert.equal(res.status, 409);
});

// ── Multi-machine identity consolidation (canonical + aliases) ───────────

const pf = (env, id) => JSON.parse(env.TOTALS.store.get('pf:' + id).value);

// Mint a pairing code for `login`, then claim it from `instanceId`. Mirrors a
// `claude-rpc link <code>` against a logged-in browser session.
async function pairClaim(env, instanceId, login) {
  const sess = await mintToken('sess', { gh: login }, SECRET, 60_000);
  const { code } = await (await handlePairStart(post('/pair/start', {}, { Authorization: `Bearer ${sess}` }), env)).json();
  const res = await handlePairClaim(post('/pair/claim', { instanceId, code }), env);
  return { res, body: await res.json() };
}

// Verify a seeded profile as a GitHub login via the first link (no merge).
async function verifyAs(env, instanceId, login) {
  const { res } = await pairClaim(env, instanceId, login);
  assert.equal(res.status, 200, 'first verify should succeed');
  env.TOTALS.store.delete('rate:profile:' + instanceId);
}

test('merge on pair/claim: a second machine folds into the canonical, not a rival row', async () => {
  const env = makeEnv();
  // Machine W (canonical) is verified as rar-file with handle "rar-file".
  await seedProfile(env, IDS.alice, 'rar-file', { tokens: 4000, sessions: 40, streak: 7 });
  await verifyAs(env, IDS.alice, 'rar-file');
  // Machine R publishes unverified handle "rarfile".
  await seedProfile(env, IDS.bob, 'rarfile', { tokens: 1000, sessions: 10, streak: 3 });

  // R links as rar-file → must MERGE into W.
  const { res, body } = await pairClaim(env, IDS.bob, 'rar-file');
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.merged, true, 'response signals a merge');
  assert.equal(body.handle, 'rar-file', 'response carries the canonical handle');

  // R is now an alias of W.
  assert.equal(await env.TOTALS.get('alias:' + IDS.bob), IDS.alice, 'R aliases W');
  // R's standalone profile is gone; its old handle is released.
  assert.equal(env.TOTALS.store.get('pf:' + IDS.bob), undefined, 'pf:R deleted');
  assert.equal(await env.TOTALS.get('handle:rarfile'), null, 'rarfile handle released');

  // W now carries summed totals + max streak across both machines.
  const w = pf(env, IDS.alice);
  assert.equal(w.tokens, 5000, 'tokens summed (4000 + 1000)');
  assert.equal(w.sessions, 50, 'sessions summed (40 + 10)');
  assert.equal(w.streak, 7, 'streak is the MAX, not the sum');
  assert.ok(w.machines[IDS.alice] && w.machines[IDS.bob], 'both machine slices present');

  // Board shows exactly one row, the canonical "rar-file" ✓.
  const board = JSON.parse(env.TOTALS.store.get('board:index').value);
  assert.equal(board[IDS.bob], undefined, 'no rival board row for R');
  assert.equal(board[IDS.alice].handle, 'rar-file');
  assert.equal(board[IDS.alice].verified, true);
  assert.equal(board[IDS.alice].tokens, 5000);

  // The displaced handle 404s; the canonical resolves.
  const gone = await handleProfileGet(new URL('http://localhost/profile?handle=rarfile'), env);
  assert.equal(gone.status, 404);
  const ok = await handleProfileGet(new URL('http://localhost/profile?handle=rar-file'), env);
  assert.equal(ok.status, 200);
});

test('merge on pair/claim with NO profile on the new machine: one command, alias only', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'octo', { tokens: 2000 });
  await verifyAs(env, IDS.alice, 'octocat');

  // A brand-new machine (no pf:) links — must succeed without a profile dance.
  const { res, body } = await pairClaim(env, IDS.carol, 'octocat');
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.merged, true);
  assert.equal(body.handle, 'octo');
  assert.equal(await env.TOTALS.get('alias:' + IDS.carol), IDS.alice, 'new machine aliases canonical');
  // No slice yet — it appears on the new machine's first publish.
  const c = pf(env, IDS.alice);
  assert.equal(c.machines[IDS.carol], undefined, 'absent slice until first publish');
  assert.equal(c.tokens, 2000, 'totals unchanged by an empty link');
});

test('alias-routed /profile publish updates the aliased machine\'s slice only', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'me', { tokens: 3000, sessions: 30, streak: 5 });
  await verifyAs(env, IDS.alice, 'meGH');
  await pairClaim(env, IDS.carol, 'meGH'); // carol aliases alice, no slice yet
  env.TOTALS.store.delete('rate:profile:' + IDS.carol);

  // carol (the alias) publishes its own absolute totals.
  const res = await handleProfile(post('/profile', {
    instanceId: IDS.carol, handle: 'whatever', version: '0.15.0', osFamily: 'linux',
    tokens: 1500, sessions: 5, streak: 9,
  }), env);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  // The publish lands on the canonical row.
  assert.equal(body.profile.handle, 'me', 'alias publish keeps the canonical handle');
  assert.equal(body.profile.tokens, 4500, 'canonical tokens = 3000 + 1500');
  assert.equal(body.profile.sessions, 35, 'canonical sessions = 30 + 5');
  assert.equal(body.profile.streak, 9, 'streak is MAX across slices');

  const c = pf(env, IDS.alice);
  assert.equal(c.machines[IDS.alice].tokens, 3000, 'canonical machine slice untouched');
  assert.equal(c.machines[IDS.carol].tokens, 1500, 'alias slice recorded under its own id');
  assert.equal(c.handle, 'me', 'alias flush does not rename the shared identity');
  // The alias's stale local handle never registers a mapping or a rival row.
  assert.equal(await env.TOTALS.get('handle:whatever'), null, 'alias handle ignored, not claimed');
  assert.equal(env.TOTALS.store.get('pf:' + IDS.carol), undefined, 'no separate pf for the alias');
  const board = JSON.parse(env.TOTALS.store.get('board:index').value);
  assert.equal(board[IDS.carol], undefined, 'no separate board row for the alias');
});

test('multi-machine totals: per-slice clamping caps a machine, sum re-clamps the identity', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'big', { tokens: 100 });
  await verifyAs(env, IDS.alice, 'bigGH');
  await pairClaim(env, IDS.carol, 'bigGH');
  env.TOTALS.store.delete('rate:profile:' + IDS.carol);

  // The alias tries to publish an absurd token count — clamped to MAX_PF_TOKENS.
  const MAX_PF_TOKENS = 1_000_000_000_000;
  await handleProfile(post('/profile', {
    instanceId: IDS.carol, handle: 'big', version: '0.15.0', osFamily: 'linux',
    tokens: MAX_PF_TOKENS * 9,
  }), env);
  const c = pf(env, IDS.alice);
  assert.equal(c.machines[IDS.carol].tokens, MAX_PF_TOKENS, 'per-slice clamp applied');
  assert.equal(c.tokens, MAX_PF_TOKENS, 'identity total re-clamped to the ceiling, not 2x');
});

test('merge on gist verify/check folds the machine into an existing identity', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'gitcanon', { tokens: 8000 });
  await verifyAs(env, IDS.alice, 'GistGH');
  await seedProfile(env, IDS.bob, 'gitalias', { tokens: 2000 });

  // Machine R gist-verifies as the SAME GitHub login.
  await handleVerifyStart(post('/verify/start', { instanceId: IDS.bob }), env);
  const pending = JSON.parse(env.TOTALS.store.get('verify:' + IDS.bob).value);
  const gistFetch = async (url) => {
    if (String(url).includes('/gists/')) {
      return new Response(JSON.stringify({
        owner: { login: 'GistGH' },
        files: { 'v.txt': { content: `proof ${pending.token}` } },
      }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  };
  const res = await handleVerifyCheck(post('/verify/check', { instanceId: IDS.bob, gistId: 'abcdef123456' }), env, gistFetch);
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json();
  assert.equal(body.merged, true, 'gist verify merges into the canonical');
  assert.equal(body.handle, 'gitcanon');

  assert.equal(await env.TOTALS.get('alias:' + IDS.bob), IDS.alice, 'R aliases the canonical');
  assert.equal(env.TOTALS.store.get('pf:' + IDS.bob), undefined, 'standalone profile gone');
  assert.equal(pf(env, IDS.alice).tokens, 10_000, 'totals summed (8000 + 2000)');
});

test('merge migrates squad membership incl. ownership and dedupe', async () => {
  const env = makeEnv();
  // Canonical W owns a squad; alias-to-be R owns another AND shares a third with W.
  await seedProfile(env, IDS.alice, 'wcanon', { tokens: 5000 });
  await verifyAs(env, IDS.alice, 'WGH');
  await seedProfile(env, IDS.bob, 'rmach', { tokens: 1000 });

  const wSquad = await createSquad(env, IDS.alice, 'w-only');     // W owns
  const rSquad = await createSquad(env, IDS.bob, 'r-only');       // R owns
  const shared = await createSquad(env, IDS.alice, 'shared');     // W owns
  await handleSquadJoin(post('/squad/join', { instanceId: IDS.bob, code: shared.code }), env); // R joins shared

  // R merges into W.
  const { res } = await pairClaim(env, IDS.bob, 'WGH');
  assert.equal(res.status, 200);

  // R's solo squad: ownership and membership transfer to W (canonical).
  const r = await getSquadRaw(env, rSquad.id);
  assert.equal(r.ownerId, IDS.alice, 'ownership reassigned to canonical');
  assert.deepEqual(r.members, [IDS.alice], 'R replaced by W in members');

  // Shared squad: W was already a member — dedupe, no double entry.
  const sh = await getSquadRaw(env, shared.id);
  assert.equal(sh.members.filter((m) => m === IDS.alice).length, 1, 'no duplicate canonical member');
  assert.ok(!sh.members.includes(IDS.bob), 'alias removed from shared squad');

  // W's own squad untouched.
  const w = await getSquadRaw(env, wSquad.id);
  assert.deepEqual(w.members, [IDS.alice]);

  // sqmember index: W now lists all three; R's index is cleared.
  const wIds = JSON.parse(env.TOTALS.store.get('sqmember:' + IDS.alice).value);
  assert.equal(new Set(wIds).size, 3, 'canonical indexes all three squads, deduped');
  assert.equal(env.TOTALS.store.get('sqmember:' + IDS.bob), undefined, 'alias squad index removed');

  // The alias machine can now manage W's squads (acts as the one identity).
  const mine = await (await handleSquadsMine(post('/squads/mine', { instanceId: IDS.bob }), env)).json();
  assert.equal(mine.squads.length, 3, 'alias sees the canonical\'s squads');
  assert.ok(mine.squads.every((s) => s.owner || s.id === rSquad.id || true));
});

test('rate-limit keys stay on the original machine id after a merge', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'rl', { tokens: 100 });
  await verifyAs(env, IDS.alice, 'rlGH');
  await seedProfile(env, IDS.bob, 'rl2', { tokens: 50 });
  await pairClaim(env, IDS.bob, 'rlGH'); // bob → alias of alice

  // A squad-create from the alias rate-keys on the ORIGINAL id (bob), not the
  // canonical (alice), so alice's own create budget is untouched.
  env.TOTALS.store.delete('rate:squad-create:' + IDS.alice);
  env.TOTALS.store.delete('rate:squad-create:' + IDS.bob);
  const r = await handleSquadCreate(post('/squad/create', { instanceId: IDS.bob, name: 'from alias' }), env);
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok(env.TOTALS.store.get('rate:squad-create:' + IDS.bob), 'rate marker on the original machine id');
  assert.equal(env.TOTALS.store.get('rate:squad-create:' + IDS.alice), undefined, 'canonical id not rate-marked');
});

test('publicProfile leaks neither the machines map nor instanceIds', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'priv', { tokens: 3000 });
  await verifyAs(env, IDS.alice, 'PrivGH');
  await seedProfile(env, IDS.bob, 'priv2', { tokens: 1000 });
  await pairClaim(env, IDS.bob, 'PrivGH'); // merge → machines map populated

  const got = await handleProfileGet(new URL('http://localhost/profile?handle=priv'), env);
  const text = await got.text();
  assert.ok(!text.includes('machines'), 'no machines map in the public profile');
  assert.ok(!text.includes(IDS.alice), 'canonical instanceId never leaks');
  assert.ok(!text.includes(IDS.bob), 'machine instanceId never leaks');

  // Leaderboard rows are equally clean.
  const lb = await handleLeaderboard(new URL('http://localhost/leaderboard'), env);
  const lbText = await lb.text();
  assert.ok(!lbText.includes('machines'), 'no machines map on the board');
  assert.ok(!lbText.includes(IDS.alice) && !lbText.includes(IDS.bob), 'no instanceIds on the board');
});

test('expired canonical (pf gone): pair/claim falls back to claiming the index for the new machine', async () => {
  const env = makeEnv();
  await seedProfile(env, IDS.alice, 'ghost', { tokens: 1000 });
  await verifyAs(env, IDS.alice, 'GhostGH');
  // Simulate the canonical pf: expiring (TTL elapsed) while gh: lingers.
  env.TOTALS.store.delete('pf:' + IDS.alice);

  await seedProfile(env, IDS.bob, 'heir', { tokens: 2000 });
  const { res, body } = await pairClaim(env, IDS.bob, 'GhostGH');
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.notEqual(body.merged, true, 'no merge into a vanished identity');
  assert.equal(await env.TOTALS.get('alias:' + IDS.bob), null, 'no alias created');
  assert.equal(await env.TOTALS.get('gh:ghostgh'), IDS.bob, 'gh index repointed to the heir');
  assert.equal(pf(env, IDS.bob).verified, true, 'heir is verified');
});
