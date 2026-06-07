// claude-rpc community-totals worker.
//
// This is the entire server. Routes:
//   POST /report         — opt-in anonymous counters from a CLI install
//   POST /profile        — opt-in leaderboard profile upsert (validated deltas)
//   GET  /profile?handle= — single public profile (powers /u/<handle>)
//   GET  /leaderboard    — top-N profiles (verified-first ranking)
//   POST /verify/start   — begin GitHub gist verification (issues a token)
//   POST /verify/check   — confirm the token appears in a public gist → ✓
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

// IP-scoped fixed-window limiter, layered on top of the per-instance one.
// The per-instance limiter is keyed on an attacker-supplied UUID, so rotating
// UUIDs trivially defeats it — this bounds total volume per source IP instead.
// Fixed window of IP_RATE_WINDOW_SEC; up to IP_RATE_MAX accepted reports per
// window. Keyed `rate:ip:<ip>:<epochWindow>`. When CF-Connecting-IP is absent
// (e.g. unit tests, or a misconfigured edge) we fall back to a single shared
// bucket so the limiter still caps anonymous volume rather than failing open
// per-request.
const IP_RATE_WINDOW_SEC = 60;
const IP_RATE_MAX        = 20;            // accepted reports per IP per window
const IP_FALLBACK_BUCKET = 'noip';
const IP_RATE_KEY        = (ip, win) => `rate:ip:${ip}:${win}`;

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
  // KV has no atomic increment, so this is a best-effort read-modify-write:
  // read the current value, add the delta, write it back. There is no
  // locking or compare-and-set, so two reports that interleave their
  // read/write can clobber each other and rarely lose a single increment.
  // That's acceptable for a vanity community counter where the exact total
  // doesn't matter. True atomicity would require migrating this state to a
  // Durable Object (which can serialize read-modify-write); we don't do that
  // here because the cost isn't worth it for an approximate aggregate.
  const cur = await getInt(env, key);
  const next = cur + delta;
  await env.TOTALS.put(key, String(next));
  return next;
}

// IP-scoped fixed-window rate limit. Returns true if the request is within
// budget for the current window, false if it should be rejected with 429.
// Uses KV read-modify-write per window key with a short TTL; like addInt this
// is best-effort (a racing pair of requests could both read the same count),
// which only ever makes the limiter slightly more permissive at the margin —
// fine for abuse mitigation. A missing IP collapses to a single shared bucket
// so anonymous/headerless volume is still bounded in aggregate.
async function ipRateOk(env, ip) {
  const bucket = ip || IP_FALLBACK_BUCKET;
  const win = Math.floor(Date.now() / 1000 / IP_RATE_WINDOW_SEC);
  const key = IP_RATE_KEY(bucket, win);
  const count = await getInt(env, key);
  if (count >= IP_RATE_MAX) return false;
  await env.TOTALS.put(key, String(count + 1), { expirationTtl: IP_RATE_WINDOW_SEC });
  return true;
}

// Extract the client IP from Cloudflare's trusted header. Returns null when
// absent (callers fall back to a shared bucket).
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || null;
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

  // IP-scoped limiter first — bounds total volume per source even when an
  // attacker rotates instanceIds to dodge the per-instance limiter.
  if (!(await ipRateOk(env, clientIp(request)))) {
    return jsonError(429, 'rate limited (ip)');
  }
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
export async function handleRef(url, env, ip = null) {
  const s = (url.searchParams.get('s') || '').toLowerCase();
  // Only count an allowlisted source AND only when within the IP budget, so a
  // single host can't inflate a referral counter by hammering the beacon.
  // Still always returns 204 — it's a fire-and-forget beacon, never an error
  // surface — we just skip the write when rate-limited.
  if (REF_SOURCES.has(s) && (await ipRateOk(env, ip))) {
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

// ── Leaderboard / public profiles ────────────────────────────────────────
//
// Hybrid trust model: anyone may publish a profile under a self-chosen handle;
// linking a GitHub identity (proven via a public gist) earns a verified ✓ and
// ranks first. You CANNOT make self-reported usage fraud-proof — there's no
// oracle for "real" token counts — so the integrity is defense-in-depth:
//   · the board sums SERVER-VALIDATED deltas, never a client-asserted total
//   · per-report plausibility caps (MAX_DELTA_*) bound how fast a profile grows
//   · per-IP + per-instance rate limits bound volume
//   · unverified entries are capped for ranking AND rank below every verified
//     one, so an unverified profile can't top the board with fake numbers
//   · verification ties the ✓ to a real GitHub account → attributable/ban-able
// Stored in KV (ranking is over the opted-in set, which is small + cached):
//   pf:<instanceId>   profile JSON (server-accumulated stats + identity)
//   handle:<handle>   → owning instanceId (uniqueness)
//   verify:<id>       pending {githubUser, token}, 1h TTL
// Profiles report ABSOLUTE lifetime totals (not deltas — a profile is per-user
// and keyed by instanceId, so the server just stores the latest value
// idempotently). These are generous plausibility ceilings: high enough never to
// reject a real power user, low enough to bound an absurd fake. Values above the
// ceiling are clamped, not rejected.
const MAX_PF_TOKENS    = 1_000_000_000_000;            // 1 trillion
const MAX_PF_SESSIONS  = 1_000_000;
const MAX_PF_ACTIVE_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years
const MAX_STREAK       = 3650;                          // ~10 years
const UNVERIFIED_TOKENS_CAP = 1_000_000_000;           // unverified ranking ceiling
const VERIFY_TTL_SECONDS    = 60 * 60;
const BOARD_MAX             = 100;
const GH_API                = 'https://api.github.com';
const PF_KEY     = (id) => `pf:${id}`;
const HANDLE_KEY = (h)  => `handle:${h}`;
const VERIFY_KEY = (id) => `verify:${id}`;

// Server-side identity normalizers. Mirrors src/leaderboard.js; the worker is a
// separate package so it can't import that module — keep the rules in sync.
function normHandle(input) {
  if (typeof input !== 'string') return null;
  const h = input.trim().toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return h.length >= 2 && h.length <= 32 ? h : null;
}
function normGithub(input) {
  if (typeof input !== 'string' || !input) return null;
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(input) ? input : null;
}
function cleanName(input) {
  if (typeof input !== 'string') return null;
  const n = [...input].filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127; }).join('').trim().slice(0, 40);
  return n || null;
}

export function validateProfile(body) {
  if (!body || typeof body !== 'object') return 'body must be an object';
  if (!isUuidish(body.instanceId)) return 'instanceId must be a UUID';
  if (!normHandle(body.handle)) return 'handle invalid';
  // Absolute lifetime totals — must be finite and non-negative; oversized
  // values are clamped (not rejected) in the handler.
  for (const k of ['tokens', 'sessions', 'activeMs', 'streak']) {
    if (body[k] == null) continue;
    const v = Number(body[k]);
    if (!Number.isFinite(v) || v < 0) return `${k} invalid`;
  }
  if (typeof body.version !== 'string' || body.version.length > 32) return 'version missing or too long';
  if (typeof body.osFamily !== 'string' || !/^(linux|darwin|win32)$/.test(body.osFamily)) return 'osFamily invalid';
  if (body.githubUser != null && !normGithub(body.githubUser)) return 'githubUser invalid';
  return null;
}

// 32 hex chars of randomness for a one-time verification token. Uses the Web
// Crypto global present in the Workers runtime; falls back to Math.random only
// in the Node test environment (older Node has no global `crypto`).
function randomHex() {
  const g = globalThis.crypto;
  if (g && typeof g.randomUUID === 'function') return g.randomUUID().replace(/-/g, '');
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

async function getProfile(env, id) {
  const raw = await env.TOTALS.get(PF_KEY(id));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function publicProfile(p) {
  return {
    handle: p.handle, displayName: p.displayName || null, githubUser: p.githubUser || null,
    verified: !!p.verified, tokens: p.tokens || 0, sessions: p.sessions || 0,
    activeMs: p.activeMs || 0, streak: p.streak || 0,
  };
}

export async function handleProfile(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'invalid JSON'); }
  const why = validateProfile(body);
  if (why) return jsonError(400, why);

  if (!(await ipRateOk(env, clientIp(request)))) return jsonError(429, 'rate limited (ip)');
  if (!(await rateOk(env, body.instanceId)))     return jsonError(429, 'rate limited');

  const handle = normHandle(body.handle);
  // Handle uniqueness: a handle belongs to exactly one instanceId.
  const owner = await env.TOTALS.get(HANDLE_KEY(handle));
  if (owner && owner !== body.instanceId) return jsonError(409, 'handle taken');

  const now = Date.now();
  const prev = (await getProfile(env, body.instanceId))
    || { tokens: 0, sessions: 0, activeMs: 0, verified: false, createdAt: now };
  // Release a previously-held handle if this instance is renaming.
  if (prev.handle && prev.handle !== handle) {
    try { await env.TOTALS.delete(HANDLE_KEY(prev.handle)); } catch { /* best-effort */ }
  }

  // Set (not accumulate) absolute totals, clamped to the ceilings. Missing
  // fields keep the previous value. Idempotent: re-sending the same totals is a
  // no-op, so there's no double-count risk and the board matches the user's
  // real aggregate exactly.
  const setClamp = (v, max, prevV) =>
    v == null ? (prevV || 0) : Math.min(max, Math.max(0, Math.floor(Number(v) || 0)));
  const next = {
    handle,
    displayName: cleanName(body.displayName) || prev.displayName || null,
    githubUser:  normGithub(body.githubUser) || prev.githubUser  || null,
    verified:    !!prev.verified, // only the verify flow flips this — never the client
    tokens:      setClamp(body.tokens,   MAX_PF_TOKENS,    prev.tokens),
    sessions:    setClamp(body.sessions, MAX_PF_SESSIONS,  prev.sessions),
    activeMs:    setClamp(body.activeMs, MAX_PF_ACTIVE_MS, prev.activeMs),
    streak:      setClamp(body.streak,   MAX_STREAK,       prev.streak),
    createdAt:   prev.createdAt || now,
    updatedAt:   now,
  };
  await env.TOTALS.put(PF_KEY(body.instanceId), JSON.stringify(next));
  await env.TOTALS.put(HANDLE_KEY(handle), body.instanceId);

  return new Response(JSON.stringify({ ok: true, profile: publicProfile(next) }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Single public profile by handle → /u/<handle> pages. 404 if unknown.
export async function handleProfileGet(url, env) {
  const handle = normHandle(url.searchParams.get('handle') || '');
  if (!handle) return jsonError(400, 'handle invalid');
  const owner = await env.TOTALS.get(HANDLE_KEY(handle));
  if (!owner) return jsonError(404, 'no such profile');
  const p = await getProfile(env, owner);
  if (!p) return jsonError(404, 'no such profile');
  return new Response(JSON.stringify({ schemaVersion: SCHEMA_VERSION, profile: publicProfile(p), ts: Date.now() }, null, 2), {
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}

export async function handleLeaderboard(url, env) {
  const metric = (url.searchParams.get('metric') || 'tokens').toLowerCase();
  const allowed = new Set(['tokens', 'sessions', 'activems', 'streak']);
  const key = allowed.has(metric) ? metric.replace('activems', 'activeMs') : 'tokens';
  const limit = Math.min(BOARD_MAX, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 50)));

  const rows = [];
  try {
    // Bound the fan-out: every listed key costs a KV get, instanceIds are
    // attacker-mintable, and Workers cap subrequests at 1000 per request —
    // an uncapped list() (default 1000 keys) would blow that budget and
    // 500 sequential gets is already the practical ceiling per hit.
    const { keys } = await env.TOTALS.list({ prefix: 'pf:', limit: 500 });
    for (const { name } of keys) {
      const instanceId = name.slice(3);
      const p = await getProfile(env, instanceId);
      // Repair: two concurrent publishes with the same handle both pass the
      // pre-write owner check (KV has no CAS). Drop rows whose handle no longer
      // maps back to this instanceId — handle:<h> is authoritative.
      if (p && p.handle && await env.TOTALS.get(HANDLE_KEY(p.handle)) === instanceId) {
        rows.push(publicProfile(p));
      }
    }
  } catch { /* list unsupported / empty → [] */ }

  // Hybrid ranking: verified first, then by metric. Unverified token counts are
  // capped for ranking so a fake entry can't top the board.
  const valueOf = (r) => {
    const v = r[key] || 0;
    return r.verified ? v : (key === 'tokens' ? Math.min(v, UNVERIFIED_TOKENS_CAP) : v);
  };
  rows.sort((a, b) => (Number(b.verified) - Number(a.verified)) || (valueOf(b) - valueOf(a)));
  const top = rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));

  return new Response(JSON.stringify({
    schemaVersion: SCHEMA_VERSION, metric: key, count: top.length, leaderboard: top, ts: Date.now(),
  }, null, 2), {
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}

export async function handleVerifyStart(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'invalid JSON'); }
  if (!isUuidish(body.instanceId)) return jsonError(400, 'instanceId must be a UUID');
  if (!(await ipRateOk(env, clientIp(request)))) return jsonError(429, 'rate limited (ip)');

  // Reuse an existing, unexpired pending token so retries are idempotent (KV
  // auto-expires the key, so if it's present it's still valid). The optional
  // githubUser is just a hint — the real account is taken from the gist owner
  // at check time, so a wrong/missing hint can't block verification.
  const existing = await env.TOTALS.get(VERIFY_KEY(body.instanceId));
  let token;
  if (existing) {
    try { token = JSON.parse(existing).token; } catch { /* regenerate below */ }
  }
  if (!token) token = 'vrf_' + randomHex();
  await env.TOTALS.put(VERIFY_KEY(body.instanceId),
    JSON.stringify({ githubUser: normGithub(body.githubUser) || null, token, ts: Date.now() }),
    { expirationTtl: VERIFY_TTL_SECONDS });
  return new Response(JSON.stringify({
    ok: true, token,
    instructions: 'Create a PUBLIC gist whose content contains this token, then POST /verify/check with its gistId.',
  }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// Gist IDs are hex; sanitize before interpolating into the API URL.
function safeGistId(id) {
  return typeof id === 'string' && /^[0-9a-f]{6,64}$/i.test(id) ? id : null;
}

export async function handleVerifyCheck(request, env, fetchImpl = fetch) {
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'invalid JSON'); }
  if (!isUuidish(body.instanceId)) return jsonError(400, 'instanceId must be a UUID');
  // Every check fans out to GitHub (up to a handful of fetches on the
  // fallback path) — rate-limit it like /verify/start so an unauthenticated
  // caller can't use the worker as an outbound-request amplifier.
  if (!(await ipRateOk(env, clientIp(request)))) return jsonError(429, 'rate limited (ip)');
  const raw = await env.TOTALS.get(VERIFY_KEY(body.instanceId));
  if (!raw) return jsonError(404, 'no pending verification — call /verify/start first');
  let pending;
  try { pending = JSON.parse(raw); } catch { return jsonError(500, 'corrupt verification state'); }

  // Preferred path: the client hands us the gist ID it just created, so we
  // fetch THAT gist directly — instant, no dependency on GitHub's laggy
  // gist-LIST index — and read the real owner. The gist owner is the verified
  // identity (the client proved control of it by writing our one-time token).
  let matchedOwner = null;
  try {
    const gid = safeGistId(body.gistId);
    if (gid) {
      const res = await fetchImpl(`${GH_API}/gists/${gid}`, {
        headers: { 'User-Agent': 'claude-rpc-worker', Accept: 'application/vnd.github+json' },
      });
      if (res.ok) {
        const g = await res.json();
        const owner = g.owner && g.owner.login;
        const hasToken = Object.values(g.files || {}).some(
          (f) => f && typeof f.content === 'string' && f.content.includes(pending.token),
        );
        if (owner && hasToken) matchedOwner = owner;
      }
    } else if (pending.githubUser) {
      // Fallback (no gistId): scan the hinted user's public gists.
      const listRes = await fetchImpl(`${GH_API}/users/${pending.githubUser}/gists?per_page=20`, {
        headers: { 'User-Agent': 'claude-rpc-worker', Accept: 'application/vnd.github+json' },
      });
      if (listRes.ok) {
        const gists = await listRes.json();
        let rawFetches = 0; // hard cap on outbound fetches — gists can have many files
        for (const g of (Array.isArray(gists) ? gists.slice(0, 20) : [])) {
          for (const f of Object.values(g.files || {})) {
            if (!f || !f.raw_url || ++rawFetches > 10) continue;
            const rr = await fetchImpl(f.raw_url, { headers: { 'User-Agent': 'claude-rpc-worker' } });
            if (rr.ok && (await rr.text()).includes(pending.token)) { matchedOwner = pending.githubUser; break; }
          }
          if (matchedOwner || rawFetches > 10) break;
        }
      }
    }
  } catch { /* GitHub hiccup → not-yet-verified */ }

  if (!matchedOwner) return jsonError(422, 'token not found in the gist yet — pass the gistId, and make sure the gist is public');

  const prof = await getProfile(env, body.instanceId);
  if (!prof) return jsonError(409, 'create your profile first (POST /profile)');
  prof.verified = true;
  prof.githubUser = matchedOwner; // authoritative: whoever actually owns the gist
  await env.TOTALS.put(PF_KEY(body.instanceId), JSON.stringify(prof));
  try { await env.TOTALS.delete(VERIFY_KEY(body.instanceId)); } catch { /* best-effort */ }
  return new Response(JSON.stringify({ ok: true, verified: true, githubUser: matchedOwner }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
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
    if (request.method === 'POST' && url.pathname === '/profile') {
      return handleProfile(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/profile') {
      return handleProfileGet(url, env);
    }
    if (request.method === 'GET' && url.pathname === '/leaderboard') {
      return handleLeaderboard(url, env);
    }
    if (request.method === 'POST' && url.pathname === '/verify/start') {
      return handleVerifyStart(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/verify/check') {
      return handleVerifyCheck(request, env);
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
      return handleRef(url, env, clientIp(request));
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
