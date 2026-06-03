// Unit tests for the worker's route handlers. We don't run wrangler dev
// here — instead we exercise the exported handler functions directly
// against an in-memory KV stub that mimics the binding's surface
// (`get`, `put` with `expirationTtl`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { validateReport, handleReport, handleBadge, handleJson, handleRef, handleRefs } = await import('../src/index.js');
const worker = (await import('../src/index.js')).default;

function makeKv() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k).value : null; },
    async put(k, v, opts = {}) {
      store.set(k, { value: String(v), ttl: opts.expirationTtl || null });
    },
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
