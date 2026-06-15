// Subscription usage — the exact numbers Claude Code's /usage screen shows
// (5-hour session window %, weekly %, per-model weekly buckets).
//
// Source: GET https://api.anthropic.com/api/oauth/usage, authenticated with
// the SAME OAuth access token Claude Code itself uses — read from
// ~/.claude/.credentials.json (Linux/Windows) or the login keychain (macOS).
// The token is sent ONLY to api.anthropic.com — its issuer — never logged,
// never stored anywhere else, never forwarded (SECURITY.md §3d). Strictly
// read-only: the refresh token is never touched (refresh rotation could
// corrupt Claude Code's own session), so an expired access token just means
// "no data until Claude Code next runs".
//
// Same contract as community.js: never throws — every failure resolves to
// { ok: false, reason }. The daemon polls while sessions are live and writes
// a small cache file; every other surface (CLI, TUI, dashboard, VS Code
// extension) reads the cache, never the credentials.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { CLAUDE_HOME, USAGE_CACHE_PATH } from './paths.js';

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
// The oauth API requires this beta header — the same one Claude Code sends.
const OAUTH_BETA = 'oauth-2025-04-20';
// A dead daemon must not pin hours-old percentages on the card: cache entries
// older than this read as "no data" and the usage frames/vars vanish.
export const USAGE_STALE_MS = 30 * 60 * 1000;

// Claude Code's credentials file: { claudeAiOauth: { accessToken, expiresAt,
// subscriptionType, ... } }. macOS may keep the same JSON in the keychain
// instead (item "Claude Code-credentials"); reading it can prompt once —
// degrade silently if denied.
export function readClaudeCredentials({ home = CLAUDE_HOME } = {}) {
  try {
    const p = join(home, '.credentials.json');
    if (existsSync(p)) {
      const o = JSON.parse(readFileSync(p, 'utf8'));
      if (o?.claudeAiOauth?.accessToken) return o.claudeAiOauth;
    }
  } catch { /* unreadable → try the keychain below */ }
  if (process.platform === 'darwin') {
    try {
      const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 4000 });
      if (r.status === 0 && r.stdout) {
        const o = JSON.parse(r.stdout.trim());
        if (o?.claudeAiOauth?.accessToken) return o.claudeAiOauth;
      }
    } catch { /* keychain locked or denied → no credentials */ }
  }
  return null;
}

// Normalize the API response to the few fields we surface. Percentages round
// to integers; absent buckets (e.g. seven_day_opus outside Max plans) → null.
// Unknown fields are deliberately ignored — the endpoint is internal and
// carries experimental buckets that come and go between releases.
export function normalizeUsage(json) {
  const bucket = (b) => (b && Number.isFinite(Number(b.utilization)))
    ? { pct: Math.round(Number(b.utilization)), resetsAt: b.resets_at || null }
    : null;
  const session = bucket(json?.five_hour);
  const week = bucket(json?.seven_day);
  if (!session && !week) return null;
  return {
    sessionPct:      session?.pct ?? null,
    sessionResetsAt: session?.resetsAt ?? null,
    weeklyPct:       week?.pct ?? null,
    weeklyResetsAt:  week?.resetsAt ?? null,
    weeklyOpusPct:   bucket(json?.seven_day_opus)?.pct ?? null,
    weeklySonnetPct: bucket(json?.seven_day_sonnet)?.pct ?? null,
  };
}

export async function fetchUsage({ fetchImpl = globalThis.fetch, creds = readClaudeCredentials(), now = Date.now() } = {}) {
  if (!creds?.accessToken) return { ok: false, reason: 'no-credentials' };
  if (creds.expiresAt && now > creds.expiresAt - 30_000) return { ok: false, reason: 'token-expired' }; // 30s skew margin — skip a request we know will 401
  let res;
  try {
    res = await fetchImpl(USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': OAUTH_BETA,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ok: false, reason: 'network', error: e.message };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized' };
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  let json;
  try { json = await res.json(); } catch { return { ok: false, reason: 'bad-json' }; }
  const usage = normalizeUsage(json);
  if (!usage) return { ok: false, reason: 'no-buckets' };
  usage.plan = typeof creds.subscriptionType === 'string' ? creds.subscriptionType : null;
  usage.fetchedAt = now;
  return { ok: true, usage };
}

export function writeUsageCache(usage, path = USAGE_CACHE_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(usage, null, 2));
  } catch { /* cache is best-effort — next poll retries */ }
}

// Fresh cache or null — staleness collapses to "no data" so consumers need
// no freshness logic of their own.
export function readUsageCache({ path = USAGE_CACHE_PATH, maxAgeMs = USAGE_STALE_MS, now = Date.now() } = {}) {
  try {
    const u = JSON.parse(readFileSync(path, 'utf8'));
    if (!u?.fetchedAt) return null;
    const age = now - u.fetchedAt;
    // Stale, or future-dated (corrupt write / clock skew) — a future fetchedAt
    // would otherwise read as fresh forever.
    if (age > maxAgeMs || age < -60_000) return null;
    return u;
  } catch { return null; }
}

// Daemon-facing one-shot: config gate → fetch → cache. Never throws.
export async function pollUsage(config, { fetchImpl } = {}) {
  if (config?.usage?.enabled === false) return { ok: false, reason: 'disabled' };
  const r = await fetchUsage(fetchImpl ? { fetchImpl } : {});
  if (r.ok) writeUsageCache(r.usage);
  return r;
}

// ── Display formatting (shared by template vars and the CLI view) ────────

// "6pm" / "6:30pm" local — how the 5-hour window reset reads on a card.
export function fmtResetTime(iso) {
  const d = new Date(iso || NaN);
  if (isNaN(d)) return '';
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
}

// "today" / "tomorrow" / "Tue" — how the weekly reset reads.
export function fmtResetDay(iso, now = new Date()) {
  const d = new Date(iso || NaN);
  if (isNaN(d)) return '';
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((that - today) / 86_400_000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'tomorrow';
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
}
