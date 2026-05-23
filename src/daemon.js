#!/usr/bin/env node
import { writeFileSync, existsSync, unlinkSync, watch, appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { Client } from '@xhayper/discord-rpc';
import { readState } from './state.js';
import { buildVars, fillTemplate, framePasses, applyIdle } from './format.js';
import { scan, readAggregate, findLiveSessions, readSessionTokens } from './scanner.js';
import { detectGithubUrl } from './git.js';
import { applyPrivacy } from './privacy.js';
import { loadConfig } from './config.js';
import { CONFIG_PATH, STATE_PATH, PID_PATH, LOG_PATH, STATE_DIR, AGGREGATE_PATH } from './paths.js';

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

// Daemon log capped at 5MB. Same policy events.jsonl uses (see hook.js).
// On rotation we move the existing log aside as `daemon.log.1` so the
// last rotation's content is still available for `claude-rpc tail`.
// One file's worth of history is enough — older logs have never been
// useful in practice, and the daemon runs for weeks.
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function maybeRotateLog() {
  try {
    const st = statSync(LOG_PATH);
    if (st.size <= LOG_ROTATE_BYTES) return;
    renameSync(LOG_PATH, LOG_PATH + '.1');
  } catch {
    // No log file yet, or rename failed (another daemon is rotating
    // simultaneously). Either case is safe to ignore — we'll just keep
    // appending and try rotation again on the next write.
  }
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  maybeRotateLog();
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    // Disk full, permission denied, or LOG_PATH became invalid mid-run.
    // The daemon must keep running regardless — Discord presence is more
    // important than file logging.
  }
  process.stdout.write(line);
}

// Wrap loadConfig so a parse/IO failure logs once and the daemon keeps
// running on baked-in defaults. The Electron settings GUI saves the file
// atomically but mid-edit hand-edits used to brick the daemon — this is
// the "no, just keep going with what we shipped" failsafe.
function loadConfigWithLog() {
  return loadConfig({ onError: (msg) => log(msg) });
}

let config = loadConfigWithLog();
let aggregate = readAggregate() || null;
let liveSessions = [];
let client = null;
let connected = false;
let lastPayloadHash = '';
let reconnectTimer = null;
// Exponential backoff for Discord reconnect: 5s → 10s → 20s → … → 300s cap.
// Reset to RECONNECT_BASE_MS on a successful connect so the next outage
// also starts gentle. Jitter (±30%) keeps multiple daemons (e.g. a user
// running both packaged and dev simultaneously) from synchronizing
// reconnect storms against Discord's IPC socket.
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_CAP_MS  = 300_000;
let reconnectDelayMs    = RECONNECT_BASE_MS;
let rotationIndex = 0;
let lastRotationAt = 0;
// Stabilizes Discord's elapsed timer: applyIdle can synthesize a sessionStart
// from a moving transcript mtime, and missing-hook scenarios leave it null —
// either case would make startTimestamp jump on every rotation.
let effectiveSessionStart = null;
// Track which status the rotation cursor belongs to so we can reset it cleanly
// on a status transition — otherwise the cursor carries over from idle's
// 7-frame rotation into a single-frame working state and back, producing a
// jarring "blank tick" until modulo aligns.
let rotationStatus = null;

writeFileSync(PID_PATH, String(process.pid));

function maybeAdvanceRotation(rotation, intervalMs) {
  if (!Array.isArray(rotation) || rotation.length === 0) return undefined;
  if (rotation.length === 1) return rotation[0];
  const now = Date.now();
  if (now - lastRotationAt >= intervalMs) {
    rotationIndex = (rotationIndex + 1) % rotation.length;
    lastRotationAt = now;
  }
  return rotation[rotationIndex % rotation.length];
}

// Choose frames + a status-level largeImageText override based on the new
// `presence.byStatus` block when present. Falls back to legacy `p.rotation`
// (which still works for any existing user config that doesn't use byStatus).
//
// Returns { frames, largeImageTextTpl }. A byStatus entry can be:
//   { details, state, largeImageText, rotation? }
// If `rotation` is present, the base { details, state } is rendered first
// and the rotation array cycles after it. Otherwise the entry is a single
// fixed frame.
function pickFrames(p, status) {
  const sb = p.byStatus?.[status];
  if (sb) {
    const base = { details: sb.details, state: sb.state, largeImageText: sb.largeImageText };
    const frames = Array.isArray(sb.rotation) && sb.rotation.length
      ? [base, ...sb.rotation]
      : [base];
    return { frames, largeImageTextTpl: sb.largeImageText || null };
  }
  if (Array.isArray(p.rotation) && p.rotation.length) {
    return { frames: p.rotation, largeImageTextTpl: null };
  }
  return { frames: [{ details: p.details, state: p.state }], largeImageTextTpl: null };
}

function buildActivity(opts = {}) {
  let state = opts.state || readState();
  // Attach live sessions BEFORE applyIdle so the stale/idle decision can
  // see ongoing transcript activity, not just this daemon's hook state.
  state.liveSessions = opts.liveSessions || liveSessions;
  state = applyIdle(state, config);

  // Pull live session tokens from the transcript file. Claude Code's hook
  // payloads don't include usage data, so state.tokens from PostToolUse
  // events is always {0,0,0,0}. The transcript is the only running source
  // of truth — readSessionTokens is mtime-cached, so this is cheap unless
  // the session is actively writing.
  if (state.cwd && state.status !== 'stale') {
    const cwdLower = state.cwd.toLowerCase();
    const match = (state.liveSessions || []).find(s =>
      (s.cwd || '').toLowerCase() === cwdLower
    );
    if (match) {
      const t = readSessionTokens(match.path);
      if (t) state.tokens = t;
    }
  }

  // Apply privacy AFTER token resolution but BEFORE buildVars — so the
  // template inputs ({project}, {currentFile}, etc.) already reflect the
  // visibility decision. Sets state._privacy so we can short-circuit to
  // clearActivity when visibility=hidden.
  state = applyPrivacy(state, config);

  const vars = buildVars(state, config, opts.aggregate || aggregate);
  const p = config.presence || {};

  // Pick the active set of frames + any status-level largeImageText override.
  // Reset the rotation cursor when status changes so a 7-frame idle rotation
  // doesn't bleed its index into a 1-frame working state.
  const { frames: rawFrames, largeImageTextTpl: statusLIT } = pickFrames(p, state.status);
  if (state.status !== rotationStatus) {
    rotationIndex = 0;
    lastRotationAt = 0;
    rotationStatus = state.status;
  }

  // Drop frames whose `requires` vars are empty/zero. Keeps presence tight.
  const frames = rawFrames.filter((f) => framePasses(f, vars));
  const safeFrames = frames.length ? frames : rawFrames.slice(0, 1);

  const intervalMs = Math.max(5000, config.rotationIntervalMs || 12000);
  const frame = maybeAdvanceRotation(safeFrames, intervalMs) || {};

  const activity = {};
  // Forcing `name` overrides whatever Discord has cached for the app's
  // display name, so every user sees the same "Playing <appName>" header
  // regardless of their client's stale application cache.
  activity.name = config.appName || 'Claude Code';
  if (frame.details) activity.details = fillTemplate(frame.details, vars).slice(0, 128);
  if (frame.state) activity.state = fillTemplate(frame.state, vars).slice(0, 128);

  // ── Large-image precedence (single source of truth) ────────────────
  //   1. statusAssets[status]      "working" gif when working, etc.
  //   2. modelAssets[opus|sonnet|haiku|default]
  //                                  per-model art (Opus/Sonnet/Haiku),
  //                                  only consulted when statusAssets
  //                                  doesn't match AND state isn't stale.
  //   3. presence.largeImageKey    global fallback.
  // smallImageKey separately resolves to the `{statusIcon}` template var
  // (set via config.statusIcons) and is dropped entirely when empty.
  let largeKeyTpl = p.largeImageKey;
  if (config.statusAssets && config.statusAssets[state.status]) {
    largeKeyTpl = config.statusAssets[state.status];
  } else if (config.modelAssets && state.model && state.status !== 'stale') {
    const m = String(state.model).toLowerCase();
    let pick = null;
    if (m.includes('opus'))   pick = config.modelAssets.opus;
    else if (m.includes('sonnet')) pick = config.modelAssets.sonnet;
    else if (m.includes('haiku'))  pick = config.modelAssets.haiku;
    if (!pick) pick = config.modelAssets.default;
    if (pick) largeKeyTpl = pick;
  }
  if (largeKeyTpl) activity.largeImageKey = fillTemplate(largeKeyTpl, vars);
  // largeImageText precedence: per-frame override > byStatus entry > global default.
  const largeTextTpl = frame.largeImageText || statusLIT || p.largeImageText;
  if (largeTextTpl) activity.largeImageText = fillTemplate(largeTextTpl, vars).slice(0, 128);

  // Small image: pick the status icon directly from vars (set via config.statusIcons).
  // Skips when the icon is empty (e.g. 'stale' has no asset).
  const smallKey = p.smallImageKey ? fillTemplate(p.smallImageKey, vars) : vars.statusIcon;
  if (smallKey && smallKey !== 'stale') {
    activity.smallImageKey = smallKey;
    activity.smallImageText = fillTemplate(p.smallImageText || '{statusVerbose}', vars).slice(0, 128);
  }

  if (state.status === 'stale') {
    effectiveSessionStart = null;
  } else if (state.sessionStart) {
    effectiveSessionStart = state.sessionStart;
  } else if (!effectiveSessionStart) {
    effectiveSessionStart = state.lastActivity || Date.now();
  }
  if (config.showElapsed && effectiveSessionStart && state.status !== 'stale') {
    // Discord IPC + @xhayper/discord-rpc expect milliseconds (not seconds).
    activity.startTimestamp = effectiveSessionStart;
  }

  // Activity type — 0=Playing, 1=Streaming, 2=Listening, 3=Watching, 5=Competing.
  // Default to Playing for backwards-compat; config can override.
  if (typeof config.activityType === 'number') activity.type = config.activityType;

  // Buttons: static configured set, optionally augmented with a per-project
  // GitHub button when the current cwd has a github origin. Privacy mode
  // suppresses the GitHub button entirely (else clicking it leaks the
  // project name we're trying to hide).
  const isPrivacyConstrained = state._privacy && state._privacy.visibility !== 'public';
  const buttons = Array.isArray(p.buttons) ? p.buttons.slice() : [];
  const gh = (!isPrivacyConstrained && state.status !== 'stale') ? detectGithubUrl(state.cwd) : null;
  if (gh && !buttons.some((b) => /github\.com/i.test(b.url || ''))) {
    buttons.unshift({ label: 'View on GitHub →', url: gh });
  }
  if (buttons.length) {
    activity.buttons = buttons.slice(0, 2).map((b) => ({
      label: fillTemplate(b.label, vars).slice(0, 32),
      url: fillTemplate(b.url, vars),
    }));
  }
  return activity;
}

async function pushPresence() {
  if (!connected || !client?.user) return;
  try {
    // Resolve state once so we can decide whether to push or clear.
    // Mirrors buildActivity's first two lines — kept here so we don't
    // have to round-trip through buildActivity just to learn the status.
    let resolved = readState();
    resolved.liveSessions = liveSessions;
    resolved = applyIdle(resolved, config);
    // Privacy can convert any state into a "hidden" verdict — give it the
    // same treatment as hideWhenStale: a single clearActivity, deduped via
    // lastPayloadHash so we don't spam the IPC.
    resolved = applyPrivacy(resolved, config);

    const hideWhenStale = config.hideWhenStale !== false;
    const privacyHidden = resolved._privacy?.visibility === 'hidden';
    if ((resolved.status === 'stale' && hideWhenStale) || privacyHidden) {
      const stamp = 'cleared';
      if (lastPayloadHash === stamp) return;
      lastPayloadHash = stamp;
      // Wipe effectiveSessionStart so the next active push gets a fresh
      // elapsed timer rather than counting from a previous session.
      effectiveSessionStart = null;
      await client.user.clearActivity();
      const reason = privacyHidden ? 'privacy=hidden in this project' : 'stale — Claude Code not running';
      log(`Presence cleared (${reason})`);
      return;
    }

    const activity = buildActivity({ state: resolved });
    const hash = JSON.stringify(activity);
    if (hash === lastPayloadHash) return;
    lastPayloadHash = hash;
    await client.user.setActivity(activity);
    log('Presence updated:', activity.details || '-', '|', activity.state || '-');
  } catch (e) {
    log('setActivity failed:', e.message, '|', e.stack?.split('\n').slice(0, 3).join(' | '));
  }
}

async function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  client = new Client({ clientId: config.clientId, transport: { type: 'ipc' } });

  client.on('ready', () => {
    connected = true;
    // Reset backoff so the next outage also starts at RECONNECT_BASE_MS.
    reconnectDelayMs = RECONNECT_BASE_MS;
    log('Discord RPC connected as', client.user?.username);
    lastPayloadHash = '';
    pushPresence();
  });
  client.on('disconnected', () => {
    connected = false;
    scheduleReconnect('Discord disconnected');
  });
  try { await client.login(); }
  catch (e) {
    scheduleReconnect(`Discord login failed: ${e.message}`);
  }
}

function scheduleReconnect(reason = 'reconnect') {
  connected = false;
  if (reconnectTimer) return;
  // ±30% jitter on the current step. Cheap protection against
  // synchronized reconnect storms from sibling daemons.
  const jitter = 0.7 + Math.random() * 0.6;
  const wait = Math.round(reconnectDelayMs * jitter);
  log(`${reason} — retry in ${Math.round(wait / 1000)}s. Is Discord desktop running?`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
  // Step the base for the *next* failure. Cap at 5min so a long Discord
  // outage doesn't push us into multi-hour silences.
  reconnectDelayMs = Math.min(RECONNECT_CAP_MS, reconnectDelayMs * 2);
}

function watchFiles() {
  let stateTimer = null;
  if (existsSync(STATE_PATH)) {
    watch(STATE_PATH, () => {
      clearTimeout(stateTimer);
      stateTimer = setTimeout(pushPresence, 250);
    });
  }
  watch(CONFIG_PATH, () => {
    log('Config changed — reloading');
    config = loadConfigWithLog();
    lastPayloadHash = '';
    pushPresence();
  });
  if (existsSync(AGGREGATE_PATH)) {
    let aggTimer = null;
    watch(AGGREGATE_PATH, () => {
      clearTimeout(aggTimer);
      aggTimer = setTimeout(() => {
        aggregate = readAggregate() || aggregate;
        lastPayloadHash = '';
        pushPresence();
      }, 250);
    });
  }

  // Mtime-poll fallback. fs.watch on Windows occasionally drops events
  // when the writer uses an atomic-rename pattern (which `state.js` does
  // and the scanner does for aggregate.json). A 30s poll comparing
  // last-seen mtime catches anything the watcher missed without making
  // the watcher itself the bottleneck. No-op on Linux/macOS most of the
  // time, but cheap enough to leave on everywhere.
  let lastStateMtime = 0, lastAggMtime = 0;
  setInterval(() => {
    try {
      if (existsSync(STATE_PATH)) {
        const m = statSync(STATE_PATH).mtimeMs;
        if (m > lastStateMtime) {
          if (lastStateMtime !== 0) {
            // The first observation is just the starting value; only
            // log + push when we actually missed a watcher event.
            log('state.json mtime advanced without a watcher event (poll fallback)');
            pushPresence();
          }
          lastStateMtime = m;
        }
      }
      if (existsSync(AGGREGATE_PATH)) {
        const m = statSync(AGGREGATE_PATH).mtimeMs;
        if (m > lastAggMtime) {
          if (lastAggMtime !== 0) {
            aggregate = readAggregate() || aggregate;
            lastPayloadHash = '';
            pushPresence();
          }
          lastAggMtime = m;
        }
      }
    } catch {
      // Stat fail mid-rotate of the watched file. The next tick will
      // pick up the new mtime. Silent on purpose.
    }
  }, 30_000);
}

async function runBackgroundScan({ force = false } = {}) {
  try {
    const t0 = Date.now();
    const { aggregate: agg, scanned, skipped, removed, total } = scan({ force });
    aggregate = agg;
    log(`Scan complete: ${scanned} parsed / ${skipped} cached / ${removed} removed / ${total} total in ${Date.now() - t0}ms — allHours=${(agg.activeMs / 3_600_000).toFixed(1)}, sessions=${agg.sessions}, tokens=${(agg.inputTokens + agg.outputTokens)}`);
    lastPayloadHash = '';
    pushPresence();
  } catch (e) {
    log('Scan failed:', e.message);
  }
}

function shutdown() {
  log('Shutting down…');
  // Both calls below are best-effort cleanup on the way out the door.
  // If the IPC client is already half-dead or the PID file was removed
  // by something else, we don't care — we're exiting anyway.
  try { client?.destroy(); } catch { /* IPC already gone */ }
  try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch { /* race vs another shutdown */ }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);

log('Claude RPC daemon starting. clientId=', config.clientId);
if (!config.clientId || config.clientId === '1234567890123456789') {
  log('WARNING: config.json contains the placeholder clientId.');
}

connect();
watchFiles();

// Push presence on a tick — also drives rotation.
const pushIntervalMs = Math.max(2000, config.updateIntervalMs || 4000);
setInterval(pushPresence, pushIntervalMs);

// Initial scan + periodic rescan.
runBackgroundScan({ force: false });
const rescanMs = Math.max(60_000, (config.rescanIntervalSec || 300) * 1000);
setInterval(() => runBackgroundScan({ force: false }), rescanMs);

// Live session polling — cheap mtime walk. With the SessionEnd hook now
// flipping claudeClosed=true authoritatively (see format.applyIdle), this
// poll is no longer the primary "is Claude open?" signal — it's a hard-kill
// backstop and the source for concurrent-session detection. 30s cadence
// keeps the disk work minimal while still surfacing a new sibling session
// within a rotation cycle or two.
function refreshLiveSessions() {
  try {
    const thresholdMs = (config.liveSessionThresholdSec || 90) * 1000;
    const next = findLiveSessions({ thresholdMs });
    const prevCount = liveSessions.length;
    liveSessions = next;
    if (next.length !== prevCount) {
      log('Concurrent sessions:', next.length, next.map((s) => `${s.project}(${s.ageSec}s)`).join(', '));
      lastPayloadHash = '';
      pushPresence();
    }
  } catch (e) {
    log('live-session poll failed:', e.message);
  }
}
refreshLiveSessions();
setInterval(refreshLiveSessions, 30_000);
