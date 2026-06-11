// claude-rpc community-totals worker.
//
// This is the entire server. Routes:
//   POST /report         — opt-in anonymous counters from a CLI install
//   POST /profile        — opt-in leaderboard profile upsert (validated deltas)
//   GET  /profile?handle= — single public profile (powers /u/<handle>)
//   GET  /leaderboard    — top-N profiles (verified-first ranking)
//   POST /verify/start   — begin GitHub gist verification (issues a token)
//   POST /verify/check   — confirm the token appears in a public gist → ✓
//   GET  /auth/login     — start the GitHub OAuth dance (web login)
//   GET  /auth/callback  — OAuth redirect target → session token → site
//   GET  /auth/me        — who am I + linked profile (Bearer session)
//   POST /squad/create   — make a private mini-leaderboard (squad)
//   POST /squad/join     — join via invite code
//   POST /squad/leave    — leave (ownership transfers / squad dissolves)
//   POST /squad/update   — owner tools: rename, regenerate code, remove member
//   POST /squads/mine    — list my squads (Bearer session or instanceId)
//   GET  /squad?id=      — public standings (weekly + lifetime)
//   GET  /squad/bycode?code= — minimal preview for the join page
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
//   gh:<login>           GitHub login → verified instanceId (web login link)
//   squad:<id> / sqcode:<code> / sqmember:<instanceId> / sqbase:<id>:<week>
//
// No PII is persisted beyond public GitHub logins users explicitly verify.
// Cloudflare's request log retains IPs briefly for abuse mitigation — that's
// a Cloudflare property, not something this worker writes. The CLI ships
// consent text that names both layers.
//
// Web sessions are stateless signed tokens (see auth.js) holding only a
// GitHub login. The browser NEVER sees an instanceId — that stays the CLI's
// credential; bearer-authed requests resolve to it server-side via gh:<login>.

import { renderBadge, fmtNum } from './badge.js';
import { mintToken, verifyToken, SESSION_TTL_MS, STATE_TTL_MS } from './auth.js';

const SCHEMA_VERSION = 1;
const MAX_DELTA_SESSIONS = 100_000;       // per single report — bigger gets rejected
const MAX_DELTA_TOKENS   = 5_000_000_000; // 5B; ~5 years of heavy use
const SEEN_TTL_SECONDS   = 30 * 24 * 60 * 60;
const RATE_WINDOW_SEC    = 60;            // 1 report/minute/instance/endpoint
// Scoped per endpoint: /report and /profile used to share one `rate:<id>`
// key, so the daemon's back-to-back community + profile flushes meant the
// profile publish ALWAYS 429'd whenever community had a delta — board totals
// only updated on cycles with nothing to report. Old unscoped keys expire
// within 60s of a deploy, so no migration is needed.
const RATE_LIMIT_KEY     = (id, scope) => `rate:${scope}:${id}`;

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
  'squad',       // squad invite/join pages — the friend-recruitment loop
  'vscode',      // the VS Code extension's onboarding menu
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

// Rate-limit: one report per instance per RATE_WINDOW_SEC, scoped per
// endpoint. Cheap to implement on KV via a TTL'd marker. Returns true if the
// report should be accepted (no marker present), false if rate-limited.
async function rateOk(env, instanceId, scope = 'report') {
  const key = RATE_LIMIT_KEY(instanceId, scope);
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
  if (!(await rateOk(env, body.instanceId, 'report'))) {
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
// A single KV blob keyed `board:index` holds { [instanceId]: boardEntry } for
// every profile ever written. handleLeaderboard reads this one blob and ranks
// in-memory — ordering is by score, not by lexicographic pf: key order — so an
// attacker cannot crowd out real users by minting low-sorting instanceIds.
// Unverified pf: entries also get a 90-day TTL so squatted profiles expire.
const BOARD_INDEX_KEY           = 'board:index';
const PF_UNVERIFIED_TTL_SECONDS = 90 * 24 * 60 * 60;

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

async function getBoardIndex(env) {
  const raw = await env.TOTALS.get(BOARD_INDEX_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// Lightweight summary kept inside board:index — everything handleLeaderboard needs.
function boardEntry(p) {
  return {
    handle:      p.handle,
    displayName: p.displayName || null,
    githubUser:  p.githubUser  || null,
    verified:    !!p.verified,
    tokens:      p.tokens   || 0,
    sessions:    p.sessions || 0,
    activeMs:    p.activeMs || 0,
    streak:      p.streak   || 0,
    updatedAt:   p.updatedAt || Date.now(),
  };
}

// Mirror the pf: TTL inside the index: unverified pf: keys expire after 90
// days, but their index entries would otherwise live forever — which turns
// the (fixed) eviction attack into a slow bloat attack on the single
// board:index blob. Drop unverified entries whose last write is older than
// the pf: TTL; verified profiles are permanent in both places.
export function pruneBoardIndex(index, now = Date.now()) {
  const cutoff = now - PF_UNVERIFIED_TTL_SECONDS * 1000;
  for (const [id, e] of Object.entries(index)) {
    if (!e || (!e.verified && (e.updatedAt || 0) < cutoff)) delete index[id];
  }
  return index;
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
  if (!(await rateOk(env, body.instanceId, 'profile'))) return jsonError(429, 'rate limited');

  const handle = normHandle(body.handle);
  // Handle uniqueness: a handle belongs to exactly one instanceId — but only
  // while that instance's profile still exists. Unverified pf: rows expire
  // after 90 days while handle:<h> has no TTL, so an expired squatter's
  // handle would otherwise stay claimed forever. If the owning profile is
  // gone, release the orphaned mapping to the new claimant.
  const owner = await env.TOTALS.get(HANDLE_KEY(handle));
  if (owner && owner !== body.instanceId) {
    const ownerProfile = await getProfile(env, owner);
    if (ownerProfile) return jsonError(409, 'handle taken');
    try { await env.TOTALS.delete(HANDLE_KEY(handle)); } catch { /* best-effort */ }
  }

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
  // Unverified profiles get a 90-day TTL so squatted entries expire automatically;
  // verified profiles are permanent.
  const pfOpts = next.verified ? {} : { expirationTtl: PF_UNVERIFIED_TTL_SECONDS };
  await env.TOTALS.put(PF_KEY(body.instanceId), JSON.stringify(next), pfOpts);
  await env.TOTALS.put(HANDLE_KEY(handle), body.instanceId);

  // Update the score-ordered index. Best-effort read-modify-write (same race
  // tolerance as addInt — acceptable for a vanity leaderboard). Pruning on
  // every write keeps the blob bounded without a scheduled job.
  try {
    const index = pruneBoardIndex(await getBoardIndex(env));
    index[body.instanceId] = boardEntry(next);
    await env.TOTALS.put(BOARD_INDEX_KEY, JSON.stringify(index));
  } catch { /* best-effort */ }

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
  if (!p) {
    // The owning pf: row expired (unverified 90-day TTL) — drop the orphaned
    // handle mapping so the handle frees up for re-registration immediately.
    try { await env.TOTALS.delete(HANDLE_KEY(handle)); } catch { /* best-effort */ }
    return jsonError(404, 'no such profile');
  }
  return new Response(JSON.stringify({ schemaVersion: SCHEMA_VERSION, profile: publicProfile(p), ts: Date.now() }, null, 2), {
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
  });
}

export async function handleLeaderboard(url, env) {
  const metric = (url.searchParams.get('metric') || 'tokens').toLowerCase();
  const allowed = new Set(['tokens', 'sessions', 'activems', 'streak']);
  const key = allowed.has(metric) ? metric.replace('activems', 'activeMs') : 'tokens';
  const limit = Math.min(BOARD_MAX, Math.max(1, Math.floor(Number(url.searchParams.get('limit')) || 50)));

  let rows = [];
  try {
    // Read the maintained board:index instead of listing pf: keys.
    // Ranking is by score, not by lexicographic KV key order, so an attacker
    // cannot crowd out real users by minting low-sorting instanceIds.
    const index = await getBoardIndex(env);
    const entries = Object.entries(index).filter(([, e]) => e && e.handle);

    // Repair duplicate handles: two concurrent publishes with the same handle
    // can both pass handleProfile's pre-write owner check (KV has no CAS),
    // leaving two index entries that share one handle. handle:<h> is
    // authoritative — resolve ownership only for handles that actually
    // collide, so the extra KV reads stay at zero in the normal case.
    const byHandle = new Map();
    for (const [id, e] of entries) {
      if (!byHandle.has(e.handle)) byHandle.set(e.handle, []);
      byHandle.get(e.handle).push([id, e]);
    }
    for (const [handle, claims] of byHandle) {
      if (claims.length === 1) { rows.push(claims[0][1]); continue; }
      const owner = await env.TOTALS.get(HANDLE_KEY(handle));
      const kept = claims.find(([id]) => id === owner);
      if (kept) rows.push(kept[1]);
    }
  } catch { /* empty → [] */ }

  // Hybrid ranking: verified first, then by metric. Unverified token counts are
  // capped for ranking so a fake entry can't top the board.
  const valueOf = (r) => {
    const v = r[key] || 0;
    return r.verified ? v : (key === 'tokens' ? Math.min(v, UNVERIFIED_TOKENS_CAP) : v);
  };
  rows.sort((a, b) => (Number(b.verified) - Number(a.verified)) || (valueOf(b) - valueOf(a)));
  // publicProfile strips index-internal fields (updatedAt) from the response.
  const top = rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...publicProfile(r) }));

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

// Headers for api.github.com. Unauthenticated calls share Cloudflare's egress
// IPs with the whole platform — GitHub's 60/hr anonymous quota is effectively
// always exhausted there, which made gist verification fail ~every time in
// production. OAuth-app Basic auth (client_id:client_secret) lifts the quota
// to the app's own 5000/hr without acting as any user.
function ghApiHeaders(env) {
  const h = { 'User-Agent': 'claude-rpc-worker', Accept: 'application/vnd.github+json' };
  if (env?.GITHUB_CLIENT_ID && env?.GITHUB_CLIENT_SECRET) {
    h.Authorization = 'Basic ' + btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`);
  }
  return h;
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
      const res = await fetchImpl(`${GH_API}/gists/${gid}`, { headers: ghApiHeaders(env) });
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
      const listRes = await fetchImpl(`${GH_API}/users/${pending.githubUser}/gists?per_page=20`, { headers: ghApiHeaders(env) });
      if (listRes.ok) {
        const gists = await listRes.json();
        let rawFetches = 0; // hard cap on outbound fetches — gists can have many files
        for (const g of (Array.isArray(gists) ? gists.slice(0, 20) : [])) {
          for (const f of Object.values(g.files || {})) {
            if (!f || !f.raw_url || ++rawFetches > 10) continue;
            const rr = await fetchImpl(f.raw_url, { headers: ghApiHeaders(env) });
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
  // Verified profiles are permanent — no TTL.
  await env.TOTALS.put(PF_KEY(body.instanceId), JSON.stringify(prof));
  // Reverse index for web login: a GitHub OAuth session for this login now
  // resolves to this profile. Last verification wins if one account verifies
  // multiple installs — the freshest machine is the one you meant.
  try { await env.TOTALS.put(GH_KEY(matchedOwner), body.instanceId); } catch { /* best-effort */ }
  try { await env.TOTALS.delete(VERIFY_KEY(body.instanceId)); } catch { /* best-effort */ }
  // Reflect verification in the board index immediately.
  try {
    const index = pruneBoardIndex(await getBoardIndex(env));
    index[body.instanceId] = boardEntry(prof);
    await env.TOTALS.put(BOARD_INDEX_KEY, JSON.stringify(index));
  } catch { /* best-effort */ }
  return new Response(JSON.stringify({ ok: true, verified: true, githubUser: matchedOwner }), {
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function jsonError(status, message) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function jsonOk(body, cacheControl = 'no-store') {
  return new Response(JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...body, ts: Date.now() }), {
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cacheControl },
  });
}

// ── Web login (GitHub OAuth) ─────────────────────────────────────────────
//
// The gist-verification flow already proves which GitHub account owns which
// profile, so "log in with GitHub" needs no accounts of its own: OAuth tells
// us the login, gh:<login> tells us the profile. Sessions are stateless
// signed tokens (auth.js) carrying ONLY the public GitHub login.

const GH_KEY = (login) => `gh:${String(login).toLowerCase()}`;
const DEFAULT_SITE_ORIGIN = 'https://claude-rpc.vercel.app';

function siteOrigin(env) {
  return (env.SITE_ORIGIN || DEFAULT_SITE_ORIGIN).replace(/\/+$/, '');
}

// Resolve a GitHub login to its verified instanceId. The gh: index is written
// at verification time; profiles verified BEFORE that index existed get a
// lazy backfill from board:index (which carries githubUser for every
// verified entry and is permanent for verified profiles).
async function resolveGithubInstance(env, login) {
  if (!normGithub(login)) return null;
  const direct = await env.TOTALS.get(GH_KEY(login));
  if (direct) return direct;
  try {
    const index = await getBoardIndex(env);
    const want = String(login).toLowerCase();
    for (const [id, e] of Object.entries(index)) {
      if (e && e.verified && String(e.githubUser || '').toLowerCase() === want) {
        await env.TOTALS.put(GH_KEY(login), id);
        return id;
      }
    }
  } catch { /* board unreadable → unlinked */ }
  return null;
}

export async function handleAuthLogin(url, env) {
  if (!env.GITHUB_CLIENT_ID || !env.SESSION_SECRET) {
    return jsonError(503, 'web login is not configured on this deployment');
  }
  // Open-redirect guard: the post-login return target must be a same-site
  // path, never a full URL.
  let ret = url.searchParams.get('return') || '/leaderboard';
  if (!/^\/[\w\-/.]*$/.test(ret)) ret = '/leaderboard';
  const state = await mintToken('state', { ret }, env.SESSION_SECRET, STATE_TTL_MS);
  const gh = new URL('https://github.com/login/oauth/authorize');
  gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  gh.searchParams.set('redirect_uri', `${url.origin}/auth/callback`);
  gh.searchParams.set('state', state);
  // No scopes: public identity only — we never see email or repos.
  return Response.redirect(gh.toString(), 302);
}

export async function handleAuthCallback(url, env, fetchImpl = fetch) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) {
    return jsonError(503, 'web login is not configured on this deployment');
  }
  const state = await verifyToken(url.searchParams.get('state'), 'state', env.SESSION_SECRET);
  if (!state) return jsonError(400, 'login expired or tampered — start again');
  const code = url.searchParams.get('code');
  if (!code) return jsonError(400, 'missing OAuth code');

  let login = null;
  try {
    const tokRes = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'claude-rpc-worker' },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
    });
    const tok = tokRes.ok ? await tokRes.json() : null;
    if (tok?.access_token) {
      const userRes = await fetchImpl('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'claude-rpc-worker' },
      });
      if (userRes.ok) login = (await userRes.json())?.login || null;
    }
  } catch { /* github hiccup → login stays null */ }
  if (!normGithub(login)) return jsonError(502, 'GitHub login failed — try again');

  // Backfill the profile link now so /auth/me is instant for old verifications.
  await resolveGithubInstance(env, login);

  const session = await mintToken('sess', { gh: login }, env.SESSION_SECRET, SESSION_TTL_MS);
  const dest = `${siteOrigin(env)}${state.ret}#token=${encodeURIComponent(session)}&gh=${encodeURIComponent(login)}`;
  return Response.redirect(dest, 302);
}

// Bearer → GitHub login, or null. Shared by /auth/me and the squad routes.
async function sessionLogin(request, env) {
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m || !env.SESSION_SECRET) return null;
  const payload = await verifyToken(m[1], 'sess', env.SESSION_SECRET);
  return payload ? payload.gh : null;
}

export async function handleAuthMe(request, env) {
  const login = await sessionLogin(request, env);
  if (!login) return jsonError(401, 'not logged in');
  const instanceId = await resolveGithubInstance(env, login);
  const prof = instanceId ? await getProfile(env, instanceId) : null;
  return jsonOk({
    githubUser: login,
    linked: !!prof,
    profile: prof ? publicProfile(prof) : null,
  });
}

// Resolve "who is making this request" to an instanceId. Two credentials:
//   web — Bearer session → GitHub login → gh:<login> index
//   CLI — body.instanceId (the same secret UUID the profile routes trust)
// Both converge so every squad is co-ownable from either surface.
async function resolveMemberId(request, env, body) {
  const login = await sessionLogin(request, env);
  if (login) {
    const id = await resolveGithubInstance(env, login);
    if (!id) {
      return { error: jsonError(403, 'no verified claude-rpc profile is linked to this GitHub account — run `claude-rpc profile verify` once, then log in again') };
    }
    return { instanceId: id, via: 'session' };
  }
  if (body && isUuidish(body.instanceId)) return { instanceId: body.instanceId, via: 'instance' };
  return { error: jsonError(401, 'authentication required') };
}

// ── Squads — private mini-leaderboards with weekly resets ────────────────
//
// A squad is a handful of people who know each other racing on weekly
// deltas. Weekly scores need no cron: the first standings read of a new ISO
// week snapshots every member's current lifetime totals as that week's
// baseline; score = current − baseline. Numbers are the same self-reported,
// clamped totals the public board uses — among friends, social accountability
// is the verification.

const SQUAD_KEY = (id) => `squad:${id}`;
const SQUAD_CODE_KEY = (code) => `sqcode:${code}`;
const SQUAD_MEMBER_KEY = (id) => `sqmember:${id}`;
const SQUAD_BASE_KEY = (id, week) => `sqbase:${id}:${week}`;
const SQUAD_MAX_MEMBERS = 20;
const SQUAD_MAX_PER_USER = 5;
const SQUAD_BASE_TTL_SECONDS = 35 * 24 * 60 * 60; // outlives its week comfortably
const SQUAD_NAME_MAX = 40;

// ISO week key in UTC ("2026-W24"). The reset moment is Monday 00:00 UTC for
// everyone — a fixed global tick beats per-user timezones for a shared race.
export function isoWeekKeyUTC(ts = Date.now()) {
  const d = new Date(ts);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3); // Thursday of this week
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 86_400_000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function cleanSquadName(input) {
  const n = cleanName(input);
  return n ? n.slice(0, SQUAD_NAME_MAX) : null;
}

// Invite codes avoid ambiguous characters (0/O, 1/I/L). Same global-crypto
// guard as randomHex: the Math.random fallback only exists for the Node 18
// test floor (no global crypto) — the Workers runtime always takes WebCrypto.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
function newInviteCode() {
  let s = '';
  const g = globalThis.crypto;
  if (g?.getRandomValues) {
    for (const b of g.getRandomValues(new Uint8Array(6))) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  } else {
    for (let i = 0; i < 6; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `SQ-${s}`;
}

function normCode(input) {
  const c = String(input || '').trim().toUpperCase();
  return /^SQ-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(c) ? c : null;
}

async function readJsonKey(env, key, fallback) {
  const raw = await env.TOTALS.get(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function getSquad(env, id) {
  if (!/^[0-9a-f]{12}$/.test(String(id || ''))) return null;
  return readJsonKey(env, SQUAD_KEY(id), null);
}

async function memberSquadIds(env, instanceId) {
  const ids = await readJsonKey(env, SQUAD_MEMBER_KEY(instanceId), []);
  return Array.isArray(ids) ? ids : [];
}

async function writeMemberSquads(env, instanceId, ids) {
  if (ids.length) await env.TOTALS.put(SQUAD_MEMBER_KEY(instanceId), JSON.stringify(ids));
  else await env.TOTALS.delete(SQUAD_MEMBER_KEY(instanceId));
}

function baselineEntry(p) {
  return { tokens: p?.tokens || 0, sessions: p?.sessions || 0, activeMs: p?.activeMs || 0 };
}

export async function handleSquadCreate(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'invalid JSON'); }
  if (!(await ipRateOk(env, clientIp(request)))) return jsonError(429, 'rate limited (ip)');
  const who = await resolveMemberId(request, env, body);
  if (who.error) return who.error;
  // Creation is the spammable op, so it gets its own per-instance window.
  // Join deliberately has no per-instance limiter — "create then immediately
  // join a friend's squad" is a normal interactive minute; possession of an
  // invite code plus the membership caps already bound join volume.
  if (!(await rateOk(env, who.instanceId, 'squad-create'))) return jsonError(429, 'rate limited');

  const name = cleanSquadName(body.name);
  if (!name) return jsonError(400, 'squad name required (1–40 printable chars)');
  const prof = await getProfile(env, who.instanceId);
  if (!prof) return jsonError(409, 'publish a profile first (claude-rpc profile on)');
  const mine = await memberSquadIds(env, who.instanceId);
  if (mine.length >= SQUAD_MAX_PER_USER) return jsonError(409, `you're already in ${SQUAD_MAX_PER_USER} squads — leave one first`);

  const id = randomHex().slice(0, 12);
  const code = newInviteCode();
  const squad = { id, name, code, ownerId: who.instanceId, members: [who.instanceId], createdAt: Date.now() };
  await env.TOTALS.put(SQUAD_KEY(id), JSON.stringify(squad));
  await env.TOTALS.put(SQUAD_CODE_KEY(code), id);
  await writeMemberSquads(env, who.instanceId, [...mine, id]);
  return jsonOk({ ok: true, squad: { id, name, code, members: 1, owner: true } });
}

export async function handleSquadJoin(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'invalid JSON'); }
  if (!(await ipRateOk(env, clientIp(request)))) return jsonError(429, 'rate limited (ip)');
  const who = await resolveMemberId(request, env, body);
  if (who.error) return who.error;

  const code = normCode(body.code);
  if (!code) return jsonError(400, 'invite code invalid — looks like SQ-XXXXXX');
  const id = await env.TOTALS.get(SQUAD_CODE_KEY(code));
  const squad = id ? await getSquad(env, id) : null;
  if (!squad || squad.code !== code) return jsonError(404, 'no squad for that code — ask for a fresh invite');
  if (squad.members.includes(who.instanceId)) {
    return jsonOk({ ok: true, squad: { id: squad.id, name: squad.name, members: squad.members.length, alreadyMember: true } });
  }
  const prof = await getProfile(env, who.instanceId);
  if (!prof) return jsonError(409, 'publish a profile first (claude-rpc profile on)');
  if (squad.members.length >= SQUAD_MAX_MEMBERS) return jsonError(409, 'squad is full');
  const mine = await memberSquadIds(env, who.instanceId);
  if (mine.length >= SQUAD_MAX_PER_USER) return jsonError(409, `you're already in ${SQUAD_MAX_PER_USER} squads — leave one first`);

  squad.members.push(who.instanceId);
  await env.TOTALS.put(SQUAD_KEY(squad.id), JSON.stringify(squad));
  await writeMemberSquads(env, who.instanceId, [...mine, squad.id]);
  // Mid-week joiner: anchor their baseline at join time so they race from 0,
  // not from negative-infinity or their whole lifetime total.
  try {
    const week = isoWeekKeyUTC();
    const baseKey = SQUAD_BASE_KEY(squad.id, week);
    const base = await readJsonKey(env, baseKey, null);
    if (base && !base[who.instanceId]) {
      base[who.instanceId] = baselineEntry(prof);
      await env.TOTALS.put(baseKey, JSON.stringify(base), { expirationTtl: SQUAD_BASE_TTL_SECONDS });
    }
  } catch { /* baseline forms on next standings read */ }
  return jsonOk({ ok: true, squad: { id: squad.id, name: squad.name, members: squad.members.length } });
}

export async function handleSquadLeave(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'invalid JSON'); }
  const who = await resolveMemberId(request, env, body);
  if (who.error) return who.error;
  const squad = await getSquad(env, body.squadId);
  if (!squad || !squad.members.includes(who.instanceId)) return jsonError(404, 'not a member of that squad');

  squad.members = squad.members.filter((m) => m !== who.instanceId);
  const mine = (await memberSquadIds(env, who.instanceId)).filter((s) => s !== squad.id);
  await writeMemberSquads(env, who.instanceId, mine);

  if (squad.members.length === 0) {
    await env.TOTALS.delete(SQUAD_KEY(squad.id));
    await env.TOTALS.delete(SQUAD_CODE_KEY(squad.code));
    return jsonOk({ ok: true, dissolved: true });
  }
  // Owner walked: the longest-standing remaining member inherits.
  if (squad.ownerId === who.instanceId) squad.ownerId = squad.members[0];
  await env.TOTALS.put(SQUAD_KEY(squad.id), JSON.stringify(squad));
  return jsonOk({ ok: true, left: true });
}

export async function handleSquadUpdate(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'invalid JSON'); }
  const who = await resolveMemberId(request, env, body);
  if (who.error) return who.error;
  const squad = await getSquad(env, body.squadId);
  if (!squad) return jsonError(404, 'no such squad');
  if (squad.ownerId !== who.instanceId) return jsonError(403, 'owner only');

  if (body.name !== undefined) {
    const name = cleanSquadName(body.name);
    if (!name) return jsonError(400, 'squad name invalid');
    squad.name = name;
  }
  if (body.regenCode) {
    await env.TOTALS.delete(SQUAD_CODE_KEY(squad.code));
    squad.code = newInviteCode();
    await env.TOTALS.put(SQUAD_CODE_KEY(squad.code), squad.id);
  }
  if (body.removeMember) {
    const handle = normHandle(body.removeMember);
    const target = handle ? await env.TOTALS.get(HANDLE_KEY(handle)) : null;
    if (!target || !squad.members.includes(target)) return jsonError(404, 'no such member');
    if (target === squad.ownerId) return jsonError(400, 'owner can leave, not self-remove');
    squad.members = squad.members.filter((m) => m !== target);
    const theirs = (await memberSquadIds(env, target)).filter((s) => s !== squad.id);
    await writeMemberSquads(env, target, theirs);
  }
  await env.TOTALS.put(SQUAD_KEY(squad.id), JSON.stringify(squad));
  return jsonOk({ ok: true, squad: { id: squad.id, name: squad.name, code: squad.code, members: squad.members.length } });
}

export async function handleSquadsMine(request, env) {
  let body = null;
  try { body = await request.json(); } catch { /* bearer-only callers send no body */ }
  const who = await resolveMemberId(request, env, body);
  if (who.error) return who.error;
  const ids = await memberSquadIds(env, who.instanceId);
  const squads = [];
  for (const id of ids) {
    const s = await getSquad(env, id);
    if (!s || !s.members.includes(who.instanceId)) continue; // index drift — heal below
    squads.push({ id: s.id, name: s.name, code: s.code, members: s.members.length, owner: s.ownerId === who.instanceId });
  }
  if (squads.length !== ids.length) {
    try { await writeMemberSquads(env, who.instanceId, squads.map((s) => s.id)); } catch { /* heal next time */ }
  }
  return jsonOk({ squads });
}

// Public standings. Knowing the (unguessable) id grants viewing; the invite
// code never appears here. Weekly baseline forms lazily on the first read of
// a new week.
export async function handleSquadGet(url, env) {
  const squad = await getSquad(env, url.searchParams.get('id'));
  if (!squad) return jsonError(404, 'no such squad');

  const profiles = new Map();
  for (const m of squad.members) {
    const p = await getProfile(env, m);
    if (p) profiles.set(m, p);
  }
  // Lazy prune: members whose profile expired (unverified 90d TTL) drop out.
  if (profiles.size !== squad.members.length) {
    squad.members = squad.members.filter((m) => profiles.has(m));
    try {
      if (squad.members.length === 0) {
        await env.TOTALS.delete(SQUAD_KEY(squad.id));
        await env.TOTALS.delete(SQUAD_CODE_KEY(squad.code));
        return jsonError(404, 'no such squad');
      }
      if (!profiles.has(squad.ownerId)) squad.ownerId = squad.members[0];
      await env.TOTALS.put(SQUAD_KEY(squad.id), JSON.stringify(squad));
    } catch { /* prune retries next read */ }
  }

  const week = isoWeekKeyUTC();
  const baseKey = SQUAD_BASE_KEY(squad.id, week);
  let base = await readJsonKey(env, baseKey, null);
  if (!base) {
    base = {};
    for (const [m, p] of profiles) base[m] = baselineEntry(p);
    try { await env.TOTALS.put(baseKey, JSON.stringify(base), { expirationTtl: SQUAD_BASE_TTL_SECONDS }); } catch { /* re-derives next read */ }
  }

  const standings = [...profiles.entries()].map(([m, p]) => {
    const b = base[m] || baselineEntry(p); // joined after snapshot → race from join point
    return {
      ...publicProfile(p),
      owner: m === squad.ownerId,
      weekTokens: Math.max(0, (p.tokens || 0) - (b.tokens || 0)),
      weekSessions: Math.max(0, (p.sessions || 0) - (b.sessions || 0)),
      weekActiveMs: Math.max(0, (p.activeMs || 0) - (b.activeMs || 0)),
    };
  }).sort((a, b) => b.weekTokens - a.weekTokens || b.tokens - a.tokens);
  standings.forEach((row, i) => { row.rank = i + 1; });

  return jsonOk({
    squad: { id: squad.id, name: squad.name, members: standings.length, week, createdAt: squad.createdAt },
    standings,
  }, 'public, max-age=30');
}

// ── CLI ↔ web pairing ("link codes") ─────────────────────────────────────
//
// The no-gist verification path. A user logged into the site already proved
// their GitHub identity via OAuth; their CLI already holds the profile's
// secret instanceId. The page mints a short one-time code bound to the
// GitHub session; `claude-rpc link <code>` claims it from the machine. Both
// identities meet at the worker — a proof at least as strong as the public
// gist dance, so it grants the same verified ✓.

const PAIR_KEY = (code) => `pair:${code}`;
const PAIR_TTL_SECONDS = 600;

function normPairCode(input) {
  const c = String(input || '').trim().toUpperCase().replace(/[^0-9A-Z]/g, '');
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(c) ? c : null;
}

export async function handlePairStart(request, env) {
  const login = await sessionLogin(request, env);
  if (!login) return jsonError(401, 'log in first');
  if (!(await ipRateOk(env, clientIp(request)))) return jsonError(429, 'rate limited (ip)');
  const code = newInviteCode().slice(3); // 6 chars, same unambiguous alphabet
  await env.TOTALS.put(PAIR_KEY(code), login, { expirationTtl: PAIR_TTL_SECONDS });
  return jsonOk({ ok: true, code, expiresInSec: PAIR_TTL_SECONDS });
}

export async function handlePairClaim(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'invalid JSON'); }
  if (!isUuidish(body.instanceId)) return jsonError(400, 'instanceId must be a UUID');
  if (!(await ipRateOk(env, clientIp(request)))) return jsonError(429, 'rate limited (ip)');
  const code = normPairCode(body.code);
  if (!code) return jsonError(400, 'link code looks wrong — it\'s the 6 characters from the squads page');
  const login = await env.TOTALS.get(PAIR_KEY(code));
  if (!login) return jsonError(404, 'code expired or unknown — grab a fresh one from claude-rpc.vercel.app/squads');
  const prof = await getProfile(env, body.instanceId);
  if (!prof) return jsonError(409, 'publish a profile first: claude-rpc profile on && claude-rpc profile publish');

  prof.verified = true;
  prof.githubUser = login;
  await env.TOTALS.put(PF_KEY(body.instanceId), JSON.stringify(prof)); // verified → permanent
  await env.TOTALS.put(GH_KEY(login), body.instanceId);
  try { await env.TOTALS.delete(PAIR_KEY(code)); } catch { /* TTL covers it */ }
  try {
    const index = pruneBoardIndex(await getBoardIndex(env));
    index[body.instanceId] = boardEntry(prof);
    await env.TOTALS.put(BOARD_INDEX_KEY, JSON.stringify(index));
  } catch { /* best-effort */ }
  return jsonOk({ ok: true, githubUser: login, handle: prof.handle, verified: true });
}

// Join-page preview: enough to render "you're joining <name> (n members)",
// nothing more. Possessing the code already grants membership, so this leaks
// nothing the holder couldn't get by joining.
export async function handleSquadByCode(url, env) {
  const code = normCode(url.searchParams.get('code'));
  const id = code ? await env.TOTALS.get(SQUAD_CODE_KEY(code)) : null;
  const squad = id ? await getSquad(env, id) : null;
  if (!squad || squad.code !== code) return jsonError(404, 'no squad for that code');
  return jsonOk({ squad: { id: squad.id, name: squad.name, members: squad.members.length } });
}

// ── Entry point ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Preflight for the browser-facing authed routes (Bearer token, no cookies
    // — so permissive CORS carries no CSRF risk; the data is public anyway).
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/auth/login') {
      return handleAuthLogin(url, env);
    }
    if (request.method === 'GET' && url.pathname === '/auth/callback') {
      return handleAuthCallback(url, env);
    }
    if (request.method === 'GET' && url.pathname === '/auth/me') {
      return handleAuthMe(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/squad/create') {
      return handleSquadCreate(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/squad/join') {
      return handleSquadJoin(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/squad/leave') {
      return handleSquadLeave(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/squad/update') {
      return handleSquadUpdate(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/squads/mine') {
      return handleSquadsMine(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/pair/start') {
      return handlePairStart(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/pair/claim') {
      return handlePairClaim(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/squad/bycode') {
      return handleSquadByCode(url, env);
    }
    if (request.method === 'GET' && url.pathname === '/squad') {
      return handleSquadGet(url, env);
    }

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
