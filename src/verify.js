// GitHub gist verification — the core shared by `profile verify` and setup's
// "connect GitHub?" question (both interactive, in cli.js) and by the daemon's
// background resume of a verification that didn't go through.
//
// Why the resume exists: from 2026-08-20 to 2026-09-11 the worker's KV write
// quota ran out by ~05:00 UTC every day, so /verify/start 500'd for anyone who
// answered "y" later in the day. Setup asks exactly once, so those installs sat
// unverified for good while their daemons kept publishing an unverified row.
// Consent is now recorded locally as `profile.verifyPending`, and the daemon
// finishes the same flow the user already agreed to once the server answers.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONFIG_PATH } from './paths.js';
import { renameSyncRetry } from './atomic-rename.js';
import { normalizeGithubUser, profileIsPublishable } from './leaderboard.js';

const FETCH_TIMEOUT_MS = 10_000;
export const PROOF_FILENAME = 'claude-rpc-verify.txt';

// Daemon retry schedule: 30 min doubling up to a 12 h ceiling, for 14 days
// from the first background attempt — long enough to outlast a multi-day
// outage (this one ran three weeks, but writes came back for a few hours
// every night), short enough that a permanently broken setup goes quiet.
export const RESUME_BASE_MS = 30 * 60_000;
export const RESUME_MAX_MS = 12 * 3_600_000;
export const RESUME_WINDOW_MS = 14 * 86_400_000;

export function resumeBackoffMs(attempts) {
  return Math.min(RESUME_MAX_MS, RESUME_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

// 1.4.0–1.4.2 recorded no intent, but setup's yes-path leaves a footprint no
// other flow does on its own: asked + publishing on + a GitHub login stored +
// never verified. migrateConfig turns that into an explicit (undated) pending
// marker once; a marker that exists in any state is never re-inferred.
export function inferLegacyVerifyIntent(profile) {
  const p = profile || {};
  return !!(p.ghConnectAsked && p.enabled === true && normalizeGithubUser(p.githubUser)
    && !p.verified && !p.verifyPending);
}

// Record (or refresh) consent to verify on a raw user-config object. Keeps the
// earliest consent time and any proof gist, but restarts the retry budget —
// the user just asked again, so a previous give-up no longer applies.
export function withVerifyIntent(userCfg, now = Date.now()) {
  const profile = userCfg.profile || {};
  const prev = profile.verifyPending && typeof profile.verifyPending === 'object' ? profile.verifyPending : {};
  const since = Number.isFinite(prev.since) ? Math.min(prev.since, now) : now;
  userCfg.profile = {
    ...profile,
    verifyPending: { since, ...(prev.gistId ? { gistId: prev.gistId } : {}) },
  };
  return userCfg;
}

// Should the daemon try a background verification now? { go } or { go:false, why }.
export function resumeDecision(profile, now = Date.now()) {
  const p = profile || {};
  const vp = p.verifyPending;
  if (!vp || typeof vp !== 'object') return { go: false, why: 'none' };
  if (p.verified) return { go: false, why: 'verified' };
  if (vp.gaveUpAt) return { go: false, why: 'gave-up' };
  // Publishing turned off (or no handle) → the row this would verify isn't
  // being kept; wait rather than burn the retry window.
  if (!profileIsPublishable(p)) return { go: false, why: 'profile-off' };
  if (vp.firstTryAt && now - vp.firstTryAt > RESUME_WINDOW_MS) return { go: false, why: 'expired' };
  if (vp.nextAt && now < vp.nextAt) return { go: false, why: 'backoff' };
  return { go: true };
}

// One pass of the dance: worker token → public proof gist → worker check.
// Never throws and never prints (onStep narrates for the CLI). Returns
//   { ok: true, githubUser, merged, handle, gistId }
//   { ok: false, stage: 'config'|'start'|'gist'|'check', status, error, gistId }
// `gistId` reuses the proof gist of an earlier attempt (edited, not
// re-created). `resumed` + `pendingSince` tell the worker this completes an
// earlier consent so it can back-date the verification to it.
export async function runGistVerify(cfg, {
  fetchImpl = globalThis.fetch,
  publish = null,
  onStep = () => {},
  gistId = null,
  pendingSince = null,
  resumed = false,
} = {}) {
  const instanceId = cfg?.community?.instanceId;
  const endpoint = (cfg?.community?.endpoint || '').replace(/\/+$/, '');
  if (!instanceId) return { ok: false, stage: 'config', status: 0, error: 'no-instance-id' };
  if (!endpoint) return { ok: false, stage: 'config', status: 0, error: 'no-endpoint' };

  const post = async (path, body) => {
    try {
      const res = await fetchImpl(endpoint + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      return { status: res.status, json: await res.json().catch(() => ({})) };
    } catch (e) {
      return { status: 0, json: { error: e.message } };
    }
  };
  const errOf = (r) => r.json?.error || (r.status ? `http-${r.status}` : 'network');

  onStep('requesting a verification token');
  const start = await post('/verify/start', { instanceId, githubUser: cfg.profile?.githubUser || null });
  if (!start.json?.token) return { ok: false, stage: 'start', status: start.status, error: errOf(start), gistId };

  onStep('publishing a public proof gist');
  let gist;
  try {
    const pub = publish || (await import('./gist.js')).publishGistFile;
    const content = `claude-rpc leaderboard verification\n${start.json.token}\n`;
    const fresh = () => pub({ svg: content, filename: PROOF_FILENAME, description: 'claude-rpc profile verification', isPublic: true });
    if (gistId) {
      // A deleted or foreign gist can't be edited; fall back to a new one.
      try { gist = await pub({ svg: content, filename: PROOF_FILENAME, gistId }); }
      catch { gist = await fresh(); }
    } else {
      gist = await fresh();
    }
  } catch (e) {
    return { ok: false, stage: 'gist', status: 0, error: e.message, gistId };
  }

  // The worker fetches THAT gist by id (no gist-list lag) and takes its real
  // owner as the verified identity.
  onStep('confirming with the server');
  const check = await post('/verify/check', {
    instanceId,
    gistId: gist.id,
    ...(resumed ? { resumed: true } : {}),
    ...(Number.isFinite(pendingSince) ? { pendingSince } : {}),
  });
  if (!check.json?.verified) return { ok: false, stage: 'check', status: check.status, error: errOf(check), gistId: gist.id };
  return {
    ok: true,
    githubUser: check.json.githubUser || gist.owner || cfg.profile?.githubUser || null,
    merged: !!check.json.merged,
    handle: check.json.handle || null,
    gistId: gist.id,
  };
}

// Read-modify-write the raw user config (never the defaults-merged view), via
// tmp + rename so the daemon's config watcher can't read a half-written file.
// `mutate` returns false to skip the write.
export function updateUserConfig(mutate, { path = CONFIG_PATH } = {}) {
  let cfg = {};
  if (existsSync(path)) {
    try { cfg = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; } // unreadable → don't clobber it
  }
  if (!cfg || typeof cfg !== 'object') return false;
  if (mutate(cfg) === false) return false;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  renameSyncRetry(tmp, path);
  return true;
}

// Persist a confirmed verification locally: authoritative login + verified
// marker, pending intent cleared.
export function markVerifiedLocally(githubUser, { path = CONFIG_PATH } = {}) {
  return updateUserConfig((cfg) => {
    const { verifyPending: _done, ...rest } = cfg.profile || {};
    cfg.profile = { ...rest, ...(githubUser ? { githubUser } : {}), verified: true };
  }, { path });
}

// Merge fields into an existing pending marker; no-op if it's gone (another
// process verified or cleared it meanwhile).
function patchPending(fields, path) {
  return updateUserConfig((cfg) => {
    const vp = cfg.profile?.verifyPending;
    if (!vp || typeof vp !== 'object' || cfg.profile.verified) return false;
    cfg.profile.verifyPending = { ...vp, ...fields };
  }, { path });
}

// Daemon entry point — called after a successful profile flush, so the row
// being verified exists. At most one attempt per call; the schedule lives in
// the pending marker itself. Returns { attempted, ok?, why? }.
export async function resumePendingVerify(config, {
  log = () => {},
  now = Date.now,
  ghLoginImpl = null,
  fetchImpl = globalThis.fetch,
  publish = null,
  configPath = CONFIG_PATH,
} = {}) {
  // The schedule and outcome live on disk and the daemon's in-memory config
  // only catches up via its file watcher — read the marker fresh so a missed
  // watch event can't re-run an attempt inside its backoff (or after success).
  let disk = {};
  try { disk = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {}; } catch { /* fall back to memory */ }
  const profile = { ...(config?.profile || {}), ...(disk?.profile || {}) };
  if (disk?.profile) profile.verifyPending = disk.profile.verifyPending; // cleared on disk = cleared
  const t = now();
  const decision = resumeDecision(profile, t);
  if (!decision.go) {
    if (decision.why === 'expired') {
      patchPending({ gaveUpAt: t }, configPath);
      log('profile: gave up retrying GitHub verification after 14 days — run `claude-rpc profile verify` to try again');
    }
    return { attempted: false, why: decision.why };
  }
  const vp = profile.verifyPending;

  // The gist owner becomes the verified identity, so only ever prove the
  // account the user connected: if gh has since been switched to another
  // account, wait instead of verifying that one.
  const want = normalizeGithubUser(profile.githubUser);
  let have = null;
  try { have = normalizeGithubUser((ghLoginImpl || (await import('./gist.js')).ghLogin)()); } catch { /* treated as logged out */ }
  let r;
  if (!have) r = { ok: false, stage: 'gh', error: 'gh CLI missing or logged out' };
  else if (want && want.toLowerCase() !== have.toLowerCase()) r = { ok: false, stage: 'gh', error: `gh is logged in as @${have}, not @${want}` };
  else r = await runGistVerify({ ...config, profile }, { fetchImpl, publish, gistId: vp.gistId || null, pendingSince: vp.since ?? null, resumed: true });

  if (r.ok) {
    markVerifiedLocally(r.githubUser, { path: configPath });
    log(`profile: finished the GitHub verification that didn't go through earlier — verified as @${r.githubUser}${r.merged ? ` (merged into @${r.handle})` : ''}`);
    return { attempted: true, ok: true };
  }
  const attempts = (vp.attempts || 0) + 1;
  const wait = resumeBackoffMs(attempts);
  patchPending({
    attempts,
    firstTryAt: vp.firstTryAt || t,
    nextAt: t + wait,
    lastError: `${r.stage}: ${r.error}`.slice(0, 200),
    ...(r.gistId ? { gistId: r.gistId } : {}),
  }, configPath);
  log(`profile: GitHub verification retry ${attempts} failed (${r.stage}: ${r.error}) — next try in ${Math.round(wait / 60_000)} min`);
  return { attempted: true, ok: false, stage: r.stage };
}
