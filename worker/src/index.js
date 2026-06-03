// claude-rpc community-totals worker.
//
// This is the entire server. Three routes:
//   POST /report         — opt-in counters from a CLI install
//   GET  /sessions.svg   — shields-style badge for the README
//   GET  /tokens.svg     — same, for tokens
//   GET  /total.json     — JSON for arbitrary consumers / dashboards
//   GET  /ref?s=<src>    — referral beacon (counts an allowlisted source)
//   GET  /refs.json      — referral breakdown by source
//   GET  /health         — sanity check
//
// Storage is a single KV namespace bound as `TOTALS`. We keep:
//   total:sessions       integer string, running sum
//   total:tokens         integer string, running sum
//   seen:<instanceId>    last-seen counters, 30d TTL (dedup window)
//
// No PII is persisted. Cloudflare's request log retains IPs briefly for
// abuse mitigation — that's a Cloudflare property, not something this
// worker writes. The CLI ships consent text that names both layers.

import { renderBadge, fmtNum } from './badge.js';

const SCHEMA_VERSION = 1;
const MAX_DELTA_SESSIONS = 100_000;       // per single report — bigger gets rejected
const MAX_DELTA_TOKENS   = 5_000_000_000; // 5B; ~5 years of heavy use
const SEEN_TTL_SECONDS   = 30 * 24 * 60 * 60;
const RATE_WINDOW_SEC    = 60;            // 1 report/minute/instance
const RATE_LIMIT_KEY     = (id) => `rate:${id}`;

// Referral attribution. The landing page fires a beacon `GET /ref?s=<source>`
// on first touch so we can see which surface actually drives visits. We count
// against a fixed ALLOWLIST only — anything else is ignored, so a stray query
// param can't pollute KV with junk keys. No PII: a per-source counter, nothing
// tied to a person. Stored as `ref:<source>`.
const REF_SOURCES = new Set([
  'discord',     // the presence-card button
  'wrapped',     // Claude Wrapped share
  'card',        // poster / calendar / profile / session card footers
  'badge',       // README badge click-through
  'readme',      // links in the GitHub README
  'github',      // the repo About / homepage link
  'npm',         // npmjs.com package page
  'hn',          // Hacker News
  'reddit',      // Reddit
  'producthunt', // Product Hunt
  'devto',       // dev.to
  'twitter',     // X / Twitter
]);

// Permissive CORS for the read-only JSON endpoints — the stats page is served
// from the Vercel origin and fetches these cross-origin.
const CORS = { 'Access-Control-Allow-Origin': '*' };

// ── Validation ─────────────────────────────────────────────────────────

function isUuidish(s) {
  // We don't require a strict v4; any 8-4-4-4-12 hex shape is fine. The
  // CLI mints with crypto.randomUUID() but a determined contributor
  // shouldn't get rejected for using a non-v4 generator.
  return typeof s === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export function validateReport(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!isUuidish(body.instanceId)) return 'instanceId must be a UUID';
  const sd = Number(body.sessionsDelta);
  const td = Number(body.tokensDelta);
  if (!Number.isFinite(sd) || sd < 0 || sd > MAX_DELTA_SESSIONS) return 'sessionsDelta out of range';
  if (!Number.isFinite(td) || td < 0 || td > MAX_DELTA_TOKENS) return 'tokensDelta out of range';
  if (sd === 0 && td === 0) return 'no delta';
  if (typeof body.version !== 'string' || body.version.length > 32) return 'version missing or too long';
  if (typeof body.osFamily !== 'string' || !/^(linux|darwin|win32)$/.test(body.osFamily)) return 'osFamily invalid';
  return null;
}

// ── KV helpers ─────────────────────────────────────────────────────────

async function getInt(env, key) {
  const v = await env.TOTALS.get(key);
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

async function addInt(env, key, delta) {
  // KV doesn't have atomic increment. Read-modify-write is good enough at
  // our volume; collisions just lose a single report and that's acceptable
  // for community-aggregate visibility. We pad the value with the current
  // unix-ms timestamp as a tiebreaker hint so a future migration to
  // Durable Objects has something to look at if we ever need real ACID.
  const cur = await getInt(env, key);
  const next = cur + delta;
  await env.TOTALS.put(key, String(next));
  return next;
}

// Rate-limit: one report per instance per RATE_WINDOW_SEC. Cheap to
// implement on KV via a TTL'd marker. Returns true if the report should
// be accepted (no marker present), false if rate-limited.
async function rateOk(env, instanceId) {
  const key = RATE_LIMIT_KEY(instanceId);
  const cur = await env.TOTALS.get(key);
  if (cur) return false;
  // expirationTtl is seconds; KV honors a minimum of 60s, which is what we want.
  await env.TOTALS.put(key, '1', { expirationTtl: RATE_WINDOW_SEC });
  return true;
}

// ── Route handlers ─────────────────────────────────────────────────────

export async function handleReport(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'invalid JSON');
  }
  const why = validateReport(body);
  if (why) return jsonError(400, why);

  if (!(await rateOk(env, body.instanceId))) {
    return jsonError(429, 'rate limited');
  }

  // Record dedup marker. We don't *enforce* dedup with this key — the
  // rate limiter already prevents floods — but downstream analytics can
  // count distinct instances from the existence of seen:<id> entries.
  await env.TOTALS.put(
    `seen:${body.instanceId}`,
    JSON.stringify({ ts: Date.now(), version: body.version, osFamily: body.osFamily }),
    { expirationTtl: SEEN_TTL_SECONDS },
  );

  const sessions = await addInt(env, 'total:sessions', Number(body.sessionsDelta));
  const tokens   = await addInt(env, 'total:tokens',   Number(body.tokensDelta));

  return new Response(JSON.stringify({
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    totals: { sessions, tokens },
  }), { headers: { 'Content-Type': 'application/json' } });
}

export async function handleBadge(metric, env) {
  const sessions = await getInt(env, 'total:sessions');
  const tokens   = await getInt(env, 'total:tokens');
  let label, value, color;
  if (metric === 'sessions') {
    label = 'community · sessions';
    value = fmtNum(sessions);
    color = { left: '#555', right: '#5865F2' }; // discord blurple
  } else if (metric === 'tokens') {
    label = 'community · tokens';
    value = fmtNum(tokens);
    color = { left: '#555', right: '#a55' };
  } else {
    return jsonError(404, 'unknown metric');
  }
  const svg = renderBadge({ label, value, color });
  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=300',
    },
  });
}

// Record a referral hit. Returns 204 regardless (it's a fire-and-forget
// beacon) but only actually counts allowlisted sources. Never throws.
export async function handleRef(url, env) {
  const s = (url.searchParams.get('s') || '').toLowerCase();
  if (REF_SOURCES.has(s)) {
    try { await addInt(env, `ref:${s}`, 1); } catch { /* best-effort */ }
  }
  return new Response(null, {
    status: 204,
    headers: { ...CORS, 'Cache-Control': 'no-store' },
  });
}

// Referral breakdown: { discord: 12, wrapped: 5, ... }. Only allowlisted
// sources are ever present (handleRef gates writes), so a list() over `ref:`
// is bounded by REF_SOURCES.size.
export async function handleRefs(env) {
  const out = {};
  let total = 0;
  try {
    const { keys } = await env.TOTALS.list({ prefix: 'ref:' });
    for (const { name } of keys) {
      const source = name.slice('ref:'.length);
      const n = await getInt(env, name);
      out[source] = n;
      total += n;
    }
  } catch { /* list unsupported / empty → {} */ }
  return new Response(JSON.stringify({ schemaVersion: SCHEMA_VERSION, refs: out, total, ts: Date.now() }, null, 2), {
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}

export async function handleJson(env) {
  const sessions = await getInt(env, 'total:sessions');
  const tokens   = await getInt(env, 'total:tokens');
  return new Response(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    sessions,
    tokens,
    ts: Date.now(),
  }, null, 2), {
    headers: {
      ...CORS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Entry point ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/report') {
      return handleReport(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/sessions.svg') {
      return handleBadge('sessions', env);
    }
    if (request.method === 'GET' && url.pathname === '/tokens.svg') {
      return handleBadge('tokens', env);
    }
    if (request.method === 'GET' && url.pathname === '/total.json') {
      return handleJson(env);
    }
    if (request.method === 'GET' && url.pathname === '/ref') {
      return handleRef(url, env);
    }
    if (request.method === 'GET' && url.pathname === '/refs.json') {
      return handleRefs(env);
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, schemaVersion: SCHEMA_VERSION }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return jsonError(404, 'not found');
  },
};
