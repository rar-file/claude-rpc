// Community-totals client. On by default for fresh installs (setup mints
// the instanceId into the seeded config); existing users upgrading from a
// pre-v0.7 config keep the explicit-opt-in flow via `claude-rpc community
// on`. Reads aggregate.json + a small cursor file to compute counter
// DELTAs (not absolute values — the cursor moves forward as we report),
// then POSTs to the configured worker endpoint.
//
// Three guarantees this module owes the rest of the codebase:
//
//   1. Never throws. The daemon calls this from a setInterval and must
//      not crash on a network burp or a malformed response. All failure
//      modes resolve to `{ ok: false, reason }` and move on.
//   2. Never sends anything beyond the documented payload. No file paths,
//      no prompts, no models, no cwd — the buildPayload function is the
//      complete schema, and it's audited by the worker's validateReport.
//   3. Never advances the cursor on a failed flush. A 5xx today + a
//      successful flush tomorrow still reports today's deltas.
//
// See worker/src/index.js for the receiving end.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { platform } from 'node:os';
import { AGGREGATE_PATH, STATE_DIR } from './paths.js';
import { VERSION } from './version.js';
import { profileIsPublishable } from './leaderboard.js';
import { projectNameIsPrivate } from './privacy.js';
import { cleanProjectName, dayKey } from './scanner.js';
import { HEATMAP_DAYS } from './heatmap.js';
import { humanModel } from './format.js';

const CURSOR_PATH = join(STATE_DIR, 'community-cursor.json');

export function readCursor(path = CURSOR_PATH) {
  if (!existsSync(path)) return { sessions: 0, tokens: 0, ts: 0 };
  try { return { sessions: 0, tokens: 0, ts: 0, ...JSON.parse(readFileSync(path, 'utf8')) }; }
  catch { return { sessions: 0, tokens: 0, ts: 0 }; }
}

export function writeCursor(c, path = CURSOR_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(c, null, 2));
  } catch {
    // Cursor write failure is recoverable — the next flush will resend
    // the same delta, which the worker accepts (we accumulate at the
    // server, not de-dup on payload content).
  }
}

export function osFamily() {
  const p = platform();
  if (p === 'win32') return 'win32';
  if (p === 'darwin') return 'darwin';
  // freebsd / openbsd / aix all collapse to 'linux' for telemetry
  // — the worker only accepts the three canonical values.
  return 'linux';
}

// Per-report caps. These mirror the worker's validateReport limits — the
// client CLAMPS each delta to them so a large first-time backfill (a heavy
// user's whole lifetime total on the very first report) STREAMS over multiple
// flushes instead of being rejected. Without this, anyone with >5B lifetime
// tokens would 400 forever (the cursor never advances on a rejected report) and
// be silently dropped from the community totals.
const MAX_REPORT_SESSIONS = 100_000;
const MAX_REPORT_TOKENS = 5_000_000_000;

// Pure: given an aggregate and a cursor, produce the next payload. The
// worker's validateReport must accept this shape; if you add a field
// here, add it there too.
export function buildPayload(aggregate, cursor, { instanceId, now = Date.now() }) {
  const sessions = aggregate?.sessions || 0;
  const tokens = (aggregate?.inputTokens || 0)
    + (aggregate?.outputTokens || 0)
    + (aggregate?.cacheReadTokens || 0)
    + (aggregate?.cacheWriteTokens || 0);
  return {
    instanceId,
    sessionsDelta: Math.min(MAX_REPORT_SESSIONS, Math.max(0, sessions - (cursor.sessions || 0))),
    tokensDelta:   Math.min(MAX_REPORT_TOKENS,   Math.max(0, tokens   - (cursor.tokens   || 0))),
    version: VERSION,
    osFamily: osFamily(),
    ts: now,
  };
}

// ── leaderboard profile flush ──────────────────────────────────────────
// Publishes the opt-in public profile (identity + lifetime totals) to the
// worker's /profile endpoint. Reuses the anonymous community instanceId as the
// profile's row key. Unlike flushCommunity this is cursor-free and idempotent —
// it POSTs absolute totals, so the worker SETs (never accumulates) and a resend
// is a no-op. Same safety guarantees: never throws, sends only documented fields.

function totalTokens(aggregate) {
  return (aggregate?.inputTokens || 0)
    + (aggregate?.outputTokens || 0)
    + (aggregate?.cacheReadTokens || 0)
    + (aggregate?.cacheWriteTokens || 0);
}

// A profile reports ABSOLUTE lifetime totals (not deltas). It's per-user and
// keyed by the instanceId, so the server just stores the latest value — no
// cursor, no double-count risk, and the board matches your real aggregate
// exactly. (Deltas were wrong here: the first publish carried the entire
// lifetime total, which blew past the per-report caps for any established user.)
// The last year of per-day tokens + active minutes, for the live heatmap
// (/heatmap/<h>.svg, /stats/<h>.svg). Keyed by LOCAL date like aggregate.byDay;
// oldest → newest with leading empty days trimmed. Only day totals — nothing
// about projects, files, or prompts. Opt out with profile.heatmap: false.
export function buildDailySeries(aggregate, now = Date.now(), days = HEATMAP_DAYS) {
  const byDay = aggregate?.byDay || {};
  const tokens = [], activeMin = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0); // noon: DST shifts can't skip or repeat a date
  const end = dayKey(d.getTime());
  d.setDate(d.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const b = byDay[dayKey(d.getTime())];
    tokens.push(b ? totalTokens(b) : 0);
    activeMin.push(b ? Math.round((b.activeMs || 0) / 60_000) : 0);
    d.setDate(d.getDate() + 1);
  }
  let first = 0;
  while (first < days && !tokens[first] && !activeMin[first]) first++;
  return { end, tokens: tokens.slice(first), activeMin: activeMin.slice(first) };
}

export function buildProfilePayload(aggregate, profileCfg, { instanceId, now = Date.now() }) {
  return {
    instanceId,
    handle: profileCfg.handle,
    displayName: profileCfg.displayName || null,
    githubUser: profileCfg.githubUser || null,
    tokens: totalTokens(aggregate),
    sessions: aggregate?.sessions || 0,
    activeMs: aggregate?.activeMs || 0,
    streak: aggregate?.streak || 0,
    // null (not omitted) on opt-out: the worker keeps a stored series when the
    // field is absent (older clients), so clearing has to be explicit.
    daily: profileCfg.heatmap === false ? null : buildDailySeries(aggregate, now),
    version: VERSION,
    osFamily: osFamily(),
    ts: now,
  };
}

// ── Claude Wrapped ───────────────────────────────────────────────────────
//
// Schema pair with the worker's validateWrapped/sanitizeWrapped — add fields
// in BOTH places. Everything here is derived from aggregate.json; per-day
// slices are year-scoped, and the few lifetime-only dimensions (languages,
// tool mix, session lengths) are labeled as such on the page. Project names
// pass the name-level privacy check AND the whole payload is shown to the
// user before anything is sent — publish is a one-shot, explicit action.
export function buildWrappedPayload(aggregate, config, { instanceId, year, now = Date.now() }) {
  const agg = aggregate || {};
  const y = year || new Date(now).getFullYear();
  const days = Object.entries(agg.byDay || {}).filter(([k]) => k.startsWith(`${y}-`));

  const sum = (f) => days.reduce((acc, [, d]) => acc + (d[f] || 0), 0);
  const tokensOf = (d) => (d.inputTokens || 0) + (d.outputTokens || 0) + (d.cacheReadTokens || 0) + (d.cacheWriteTokens || 0);
  const tokens = days.reduce((acc, [, d]) => acc + tokensOf(d), 0);
  const cacheTokens = days.reduce((acc, [, d]) => acc + (d.cacheReadTokens || 0) + (d.cacheWriteTokens || 0), 0);

  // Peak day by active time.
  let peakDay = null;
  for (const [date, d] of days) {
    if ((d.activeMs || 0) > 0 && (!peakDay || d.activeMs > peakDay.activeMs)) {
      peakDay = { date, activeMs: d.activeMs };
    }
  }

  // Year-scoped project ranking from per-day attribution, privacy-filtered.
  const projMs = {};
  for (const [, d] of days) {
    for (const [name, p] of Object.entries(d.projects || {})) {
      projMs[name] = (projMs[name] || 0) + (p.activeMs || 0);
    }
  }
  const topProjects = Object.entries(projMs)
    .filter(([name]) => !projectNameIsPrivate(name, config, cleanProjectName))
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, activeMs]) => ({ name, activeMs }));

  // Year-scoped model mix from the per-day byModel buckets (scan cache v7).
  // Share is by SPEND, matching the local wrapped's "your models, by spend"
  // slide; token share is the fallback when everything costed to zero. Names
  // are humanized here so the web story renders "Opus 4.8", same as local.
  const modelAgg = {};
  for (const [, d] of days) {
    for (const [m, v] of Object.entries(d.byModel || {})) {
      const t = (modelAgg[m] ||= { tokens: 0, cost: 0 });
      t.tokens += v.tokens || 0;
      t.cost += v.cost || 0;
    }
  }
  const costTotal = Object.values(modelAgg).reduce((a, b) => a + b.cost, 0);
  const tokTotal = Object.values(modelAgg).reduce((a, b) => a + b.tokens, 0);
  const share = (v) => costTotal > 0 ? v.cost / costTotal : (tokTotal > 0 ? v.tokens / tokTotal : 0);
  const topModels = Object.entries(modelAgg).sort((a, b) => share(b[1]) - share(a[1])).slice(0, 4)
    .map(([name, v]) => ({ name: humanModel(name) || name, pct: Math.round(share(v) * 100) }));

  // Lifetime dimensions (no yearly slice exists for these).
  const toolTotal = Object.values(agg.toolBreakdown || {}).reduce((a, b) => a + b, 0);
  const toolMix = Object.entries(agg.toolBreakdown || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([name, n]) => ({ name, pct: toolTotal ? Math.round((n / toolTotal) * 100) : 0 }));
  const topLanguages = Object.entries(agg.languages || {})
    .sort((a, b) => (b[1].edits || 0) - (a[1].edits || 0)).slice(0, 5)
    .map(([name, v]) => ({ name, edits: v.edits || 0 }));
  const sl = agg.sessionLengths || {};
  const marathonPct = sl.count ? Math.round((((sl.buckets?.h2to4 || 0) + (sl.buckets?.gt4h || 0)) / sl.count) * 100) : 0;

  // The hotspot file (basename only, never a path) and peak weekday — the two
  // remaining slides of the local story. Both lifetime, like the local page.
  const top = (agg.topEditedFiles || [])[0] || null;
  const hotName = top ? String(top.path || '').split(/[\\/]/).pop() : null;
  const hotspot = top && hotName && !projectNameIsPrivate(hotName, config, cleanProjectName)
    ? { name: hotName, count: top.count || 0, ...(top.daysSinceLastEdit != null ? { daysSinceLastEdit: top.daysSinceLastEdit } : {}) }
    : null;
  let peakWeekday = null;
  {
    const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    for (const [k, v] of Object.entries(agg.byWeekday || {})) {
      if ((v.activeMs || 0) > 0 && (!peakWeekday || v.activeMs > peakWeekday.activeMs)) {
        peakWeekday = { name: WD[Number(k)] || '', activeMs: v.activeMs };
      }
    }
  }

  const compactions = Object.entries(agg.compactionsByDay || {})
    .filter(([k]) => k.startsWith(`${y}-`)).reduce((acc, [, n]) => acc + n, 0);

  return {
    instanceId,
    year: y,
    wrapped: {
      activeMs: sum('activeMs'),
      sessions: sum('sessions'),
      tokens,
      prompts: sum('userMessages'),
      streakBest: agg.longestStreak || 0,
      streak: agg.streak || 0,
      daysSinceFirst: agg.daysSinceFirst || 0,
      daysActive: days.filter(([, d]) => (d.activeMs || 0) > 0 || (d.userMessages || 0) > 0).length,
      linesAdded: sum('linesAdded'),
      linesRemoved: sum('linesRemoved'),
      ships: sum('ships'),
      cachePct: tokens ? Math.round((cacheTokens / tokens) * 100) : 0,
      peakHour: agg.peakHour?.hour ?? 0,
      ...(peakDay ? { peakDay } : {}),
      longestSessionMs: sl.longestMs || 0,
      marathonPct,
      compactions,
      subagentActiveMs: agg.subagentActiveMs || 0,
      costUsd: Math.round(sum('cost') * 100) / 100,
      topProjects,
      topLanguages,
      topModels,
      toolMix,
      ...(hotspot ? { hotspot } : {}),
      ...(peakWeekday ? { peakWeekday } : {}),
    },
  };
}

// One-shot POST of a built wrapped payload. Mirrors flushProfile's error
// contract: never throws, returns { ok, reason?, url? }.
export async function publishWrapped(cfg, payload, { fetchImpl = globalThis.fetch } = {}) {
  const community = cfg?.community || {};
  if (!community.endpoint) return { ok: false, reason: 'no-endpoint' };
  const url = community.endpoint.replace(/\/+$/, '') + '/wrapped';
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ok: false, reason: 'network', error: e.message };
  }
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    if (res.status === 403) return { ok: false, reason: 'no-profile' };
    if (res.status === 429) return { ok: false, reason: 'rate-limited' };
    return { ok: false, reason: `http-${res.status}`, error: body?.error };
  }
  return { ok: true, url: body?.url, handle: body?.handle, year: body?.year };
}

export async function flushProfile(cfg, {
  aggregatePath = AGGREGATE_PATH,
  fetchImpl = globalThis.fetch,
} = {}) {
  const profile = cfg?.profile || {};
  const community = cfg?.community || {};
  if (!profileIsPublishable(profile)) return { ok: false, reason: 'disabled' };
  const instanceId = community.instanceId;
  if (!instanceId) return { ok: false, reason: 'no-instance-id' };
  if (!community.endpoint) return { ok: false, reason: 'no-endpoint' };
  if (!existsSync(aggregatePath)) return { ok: false, reason: 'no-aggregate' };

  let aggregate;
  try { aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8')); }
  catch { return { ok: false, reason: 'unreadable-aggregate' }; }

  const payload = buildProfilePayload(aggregate, profile, { instanceId });
  const url = community.endpoint.replace(/\/+$/, '') + '/profile';
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000), // bare fetch never times out; a hung peer would wedge the 30-min flush loop
    });
  } catch (e) {
    return { ok: false, reason: 'network', error: e.message };
  }
  if (!res.ok) {
    if (res.status === 429) return { ok: false, reason: 'rate-limited' };
    return { ok: false, reason: `http-${res.status}` };
  }
  return { ok: true, totals: { tokens: payload.tokens, sessions: payload.sessions, activeMs: payload.activeMs } };
}

// Single best-effort flush. Returns { ok, reason, delta? } — never throws.
// Caller passes in the merged config so we can be tested without touching
// disk for config too.
export async function flushCommunity(cfg, {
  aggregatePath = AGGREGATE_PATH,
  cursorPath = CURSOR_PATH,
  fetchImpl = globalThis.fetch,
} = {}) {
  const community = cfg?.community || {};
  if (!community.enabled) return { ok: false, reason: 'disabled' };
  if (!community.instanceId) return { ok: false, reason: 'no-instance-id' };
  if (!community.endpoint) return { ok: false, reason: 'no-endpoint' };
  if (!existsSync(aggregatePath)) return { ok: false, reason: 'no-aggregate' };

  let aggregate;
  try { aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8')); }
  catch { return { ok: false, reason: 'unreadable-aggregate' }; }

  const cursor = readCursor(cursorPath);
  const payload = buildPayload(aggregate, cursor, { instanceId: community.instanceId });
  if (payload.sessionsDelta === 0 && payload.tokensDelta === 0) {
    return { ok: true, reason: 'no-delta' };
  }

  const url = community.endpoint.replace(/\/+$/, '') + '/report';
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000), // bare fetch never times out; a hung peer would wedge the 30-min flush loop
    });
  } catch (e) {
    return { ok: false, reason: 'network', error: e.message };
  }
  if (!res.ok) {
    // 429 is rate-limit — not actually a failure, just "come back later".
    if (res.status === 429) return { ok: false, reason: 'rate-limited' };
    return { ok: false, reason: `http-${res.status}` };
  }

  // Only move the cursor on confirmed acceptance. If we crash between
  // the response and the cursor write, the next flush resends — the
  // worker accumulates blindly, so a duplicate would double-count.
  // Rate-limiting on the worker side bounds the damage to one
  // duplicate per minute per instance.
  writeCursor({
    sessions: (cursor.sessions || 0) + payload.sessionsDelta,
    tokens:   (cursor.tokens   || 0) + payload.tokensDelta,
    ts: payload.ts,
  }, cursorPath);

  return {
    ok: true,
    delta: { sessions: payload.sessionsDelta, tokens: payload.tokensDelta },
  };
}
