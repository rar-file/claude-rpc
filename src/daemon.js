#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync, unlinkSync, watch, appendFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { Client } from './discord-ipc.js';
import { readState, sweepStaleStateTmp, listSessionStates, sweepStaleSessionStates } from './state.js';
import { makeRotationCursor, pickFrames, selectFrame, resolveLargeImageKey, shouldShowGithubButton, pickActiveSession } from './presence.js';
import { buildVars, fillTemplate, framePasses, applyIdle, applyShipped, applyTrigger } from './format.js';
import { scan, readAggregate, findLiveSessions, readSessionTokens } from './scanner.js';
import { detectGithubUrl } from './git.js';
import { applyPrivacy } from './privacy.js';
import { pauseUntil } from './pause.js';
import { loadConfig } from './config.js';
import { migrateConfig } from './install.js';
import { desktopNotify, postWebhook, shouldWebhook, shouldNotify, sanitizeLabel } from './notify.js';
import { humanProject } from './format.js';
import { CONFIG_PATH, STATE_PATH, PID_PATH, LOG_PATH, STATE_DIR, AGGREGATE_PATH, PAUSE_PATH } from './paths.js';
import { readUsageCache, pollUsage } from './usage.js';
import { pollDecision, pollIntervalMs } from './watch-poll.js';

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

// Bring an existing config.json up to date with the current defaults before
// we load it. This is how upgrades reach users who just `npm update` + restart
// the daemon without re-running `claude-rpc setup` — e.g. the v0.8.1 button-URL
// move. Idempotent: only writes when something actually changes, so steady-state
// restarts are a no-op and can't loop the config watcher. Best-effort — a
// migration failure must never stop the daemon from starting.
try {
  if (migrateConfig({ silent: true })) {
    log('config.json migrated to current defaults on startup');
  }
} catch (e) {
  log('startup config migration failed (continuing):', e?.message || String(e));
}

let config = loadConfigWithLog();
let aggregate = readAggregate() || null;
let liveSessions = [];
let client = null;
let connected = false;
let connecting = false; // login() in flight — see the watchdog note in connect()
let lastPayloadHash = '';
// Last status we acted on for outbound side-effects (webhook / desktop notify).
// Tracked separately from the render hash so we fire once per transition.
let lastNotifiedStatus = null;
let reconnectTimer = null;
// Exponential backoff for Discord reconnect: 5s → 10s → 20s → … → 300s cap.
// Reset to RECONNECT_BASE_MS on a successful connect so the next outage
// also starts gentle. Jitter (±30%) keeps multiple daemons (e.g. a user
// running both packaged and dev simultaneously) from synchronizing
// reconnect storms against Discord's IPC socket.
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_CAP_MS  = 300_000;
let reconnectDelayMs    = RECONNECT_BASE_MS;
// Rotation cursor (index + lastAt + status). selectFrame in presence.js resets
// it on a status transition — otherwise the cursor carries over from idle's
// 12-frame rotation into a single-frame working state and back, producing a
// jarring "blank tick" until modulo aligns.
const rotationCursor = makeRotationCursor();
// Which concurrent session's card we're currently showing. pickActiveSession
// keeps it sticky — see resolvePresence.
let displayedSessionId = null;
// Stabilizes Discord's elapsed timer: applyIdle can synthesize a sessionStart
// from a moving transcript mtime, and missing-hook scenarios leave it null —
// either case would make startTimestamp jump on every rotation.
let effectiveSessionStart = null;

// Single-instance guard. The CLI checks before spawning, but off-path launches
// (a login-startup entry racing a manual start; a packaged exe beside a dev
// run) could start a second daemon that fights over setActivity every ~4s and
// double-counts the additive community total. If a live daemon already owns the
// PID file, step aside; a stale PID (owner gone) means take over.
try {
  if (existsSync(PID_PATH)) {
    const existing = parseInt(readFileSync(PID_PATH, 'utf8'), 10);
    if (existing && existing !== process.pid) {
      let alive = false;
      try { process.kill(existing, 0); alive = true; } catch { /* stale PID — take over */ }
      if (alive) {
        log(`Another daemon (pid ${existing}) is already running — exiting.`);
        process.exit(0);
      }
    }
  }
} catch { /* unreadable PID file — fall through and claim it */ }
writeFileSync(PID_PATH, String(process.pid));

// Reclaim any per-pid state tmp files orphaned by a hard-killed writer, plus
// per-session state files from sessions that ended long ago.
sweepStaleStateTmp();
sweepStaleSessionStates();

// pickFrames / selectFrame / resolveLargeImageKey now live in presence.js (pure
// + unit-tested). The rotation cursor (rotationCursor) is owned here and passed
// into selectFrame.

// Resolve the raw state file into the final presence state: idle/stale, shipped
// and trigger overlays, live-session token enrichment, and the privacy verdict.
// Run ONCE per tick (in pushPresence) and reused by buildActivity, so the
// clear-vs-push decision and the rendered frame are guaranteed to agree —
// previously this chain ran twice and only buildActivity applied the trigger
// overlay, so the two could diverge.
function resolvePresence(opts = {}) {
  let state;
  if (opts.state) {
    state = opts.state; // standalone caller (preview/api) passes an explicit state
  } else {
    // Multi-session: each session writes its own state-<id>.json. Pick which one
    // to show, sticking with the current session while it's active so the card
    // doesn't thrash between projects (which also stabilizes the elapsed timer
    // and the GitHub button — both follow the displayed session). Fall back to
    // the legacy global state.json when there are no per-session files.
    const sessions = listSessionStates();
    if (sessions.length) {
      const idleMs = Math.max(30_000, (config.idleThresholdSec || 60) * 1000);
      const picked = pickActiveSession(sessions, displayedSessionId, Date.now(), idleMs);
      displayedSessionId = picked.sessionId;
      state = picked.state || readState();
      // Party count from the SAME per-session list we selected from, so the
      // "N sessions" field stays consistent with the card instead of wobbling
      // on transcript-mtime timing.
      state._liveCount = picked.liveCount;
    } else {
      state = readState();
    }
  }
  // Attach live sessions BEFORE applyIdle so the stale/idle decision can
  // see ongoing transcript activity, not just this daemon's hook state.
  state.liveSessions = opts.liveSessions || liveSessions;
  state = applyIdle(state, config);
  // Shipped overlay sits on top of idle/working/thinking — but never over
  // stale (we don't celebrate when Claude isn't running).
  state = applyShipped(state, config);
  // Custom-command trigger overlay (config.triggers) — never over stale/shipped.
  state = applyTrigger(state, config);

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
  return state;
}

function buildActivity(opts = {}) {
  // opts.resolved is an already-resolved state (the common path, from
  // pushPresence). Fall back to resolving here for any standalone caller.
  const state = opts.resolved || resolvePresence(opts);

  // Subscription usage rides in like liveSessions: injected onto state so
  // buildVars stays pure. Stale/missing cache → null → usage frames vanish.
  state.usage = readUsageCache();
  const vars = buildVars(state, config, opts.aggregate || aggregate);
  const p = config.presence || {};

  // Pick the active set of frames + any status-level largeImageText override.
  // Reset the rotation cursor when status changes so a 7-frame idle rotation
  // doesn't bleed its index into a 1-frame working state.
  let rawFrames, statusLIT;
  if (state.status === 'trigger' && state._triggerFrame) {
    rawFrames = [state._triggerFrame];
    statusLIT = state._triggerFrame.largeImageText || null;
  } else {
    ({ frames: rawFrames, largeImageTextTpl: statusLIT } = pickFrames(p, state.status));
  }
  // Select the frame for this tick: filter by `requires`, reset the cursor on a
  // status change (starting on the base frame), advance once per intervalMs.
  const intervalMs = Math.max(5000, config.rotationIntervalMs || 12000);
  const frame = selectFrame(rawFrames, vars, state.status, rotationCursor, intervalMs, framePasses, Date.now());

  const activity = {};
  // Forcing `name` overrides whatever Discord has cached for the app's
  // display name, so every user sees the same "Playing <appName>" header
  // regardless of their client's stale application cache.
  activity.name = config.appName || 'Claude Code';
  if (frame.details) activity.details = fillTemplate(frame.details, vars).slice(0, 128);
  if (frame.state) activity.state = fillTemplate(frame.state, vars).slice(0, 128);

  // Large-image precedence (statusAssets[status] > modelAssets[tier] > global)
  // lives in presence.js/resolveLargeImageKey. smallImageKey separately resolves
  // to the `{statusIcon}` template var (config.statusIcons), dropped when empty.
  const largeKeyTpl = resolveLargeImageKey(config, p, state.status, state.model);
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
    // Discord IPC expects millisecond timestamps (not seconds).
    activity.startTimestamp = effectiveSessionStart;
  }

  // Activity type — 0=Playing, 1=Streaming, 2=Listening, 3=Watching, 5=Competing.
  // Default to Playing for backwards-compat; config can override.
  if (typeof config.activityType === 'number') activity.type = config.activityType;

  // Buttons: static configured set, optionally augmented with a per-project
  // GitHub button when the current cwd has a github origin. Suppressed under any
  // non-public privacy verdict (else the link leaks the project we're hiding),
  // while stale, and when presence.githubButton is set to false (the explicit
  // off switch — works even without the gh CLI that private-repo detection needs).
  const buttons = Array.isArray(p.buttons) ? p.buttons.slice() : [];
  const gh = shouldShowGithubButton(p, state) ? detectGithubUrl(state.cwd) : null;
  if (gh && !buttons.some((b) => /github\.com/i.test(b.url || ''))) {
    buttons.unshift({ label: 'View on GitHub →', url: gh });
  }
  if (buttons.length) {
    activity.buttons = buttons.slice(0, 2).map((b) => ({
      label: fillTemplate(b.label, vars).slice(0, 32),
      url: fillTemplate(b.url, vars),
    }));
  }

  // Concurrent sessions render natively via Discord's party field — the card
  // shows "(2 of 2)" with no template work. Only attached when more than one
  // live session exists (a party of one is noise). Opt out: showPartySize:false.
  // Prefer the per-session count (consistent with the displayed session); fall
  // back to the transcript-derived count for the legacy single-state path.
  const liveCount = state._liveCount != null ? state._liveCount : (state.liveSessions || []).length;
  if (config.showPartySize !== false && liveCount > 1) {
    activity.partyId = 'claude-rpc';
    activity.partySize = liveCount;
    activity.partyMax = liveCount;
  }
  return activity;
}

// Fire desktop-notification + webhook on a status transition (once per change).
// When `suppressed` (paused / privacy=hidden), we still advance the transition
// cursor — so resume doesn't replay a stale notification — but stay silent, or
// the webhook/toast would leak the project name and defeat the snooze.
function fireStatusSideEffects(resolved, suppressed = false) {
  const status = resolved.status;
  if (status === lastNotifiedStatus) return;
  const prev = lastNotifiedStatus;
  lastNotifiedStatus = status;
  if (suppressed) return;
  try {
    // Sanitize the cwd-derived project name before it reaches a notifier or
    // webhook — see sanitizeLabel (closes a win32 PowerShell injection via a
    // maliciously-named directory).
    const project = sanitizeLabel(humanProject(resolved.cwd)) || 'Claude Code';
    if (shouldNotify(config.notify, prev, status)) {
      desktopNotify('Claude Code needs you', `Waiting on you in ${project}`);
      log(`desktop notification raised (status=${status})`);
    }
    if (shouldWebhook(config.webhook, prev, status)) {
      postWebhook(config.webhook.url, {
        status,
        project,
        model: resolved.model || null,
        justShipped: resolved.justShippedKind || null,
        ts: Date.now(),
      });
      log(`webhook: POSTed status=${status} (${project})`);
    }
  } catch (e) {
    log('status side-effect failed:', e.message);
  }
}

async function pushPresence() {
  if (!connected || !client?.user) return;
  try {
    // Resolve state ONCE — this same object decides clear-vs-push, drives the
    // status side-effects, AND is rendered by buildActivity, so there's no way
    // for the decision and the frame to disagree.
    const resolved = resolvePresence();

    const hideWhenStale = config.hideWhenStale !== false;
    const privacyHidden = resolved._privacy?.visibility === 'hidden';
    // Global snooze (`claude-rpc pause`) — clears the card while the deadline
    // is in the future. Re-checked every tick, so expiry resumes presence
    // automatically (the 'cleared' stamp differs from the next frame's hash).
    const pausedUntil = pauseUntil();
    const suppressed = privacyHidden || !!pausedUntil || (resolved.status === 'stale' && hideWhenStale);

    // Outbound side-effects on a status TRANSITION (fire once per change): a
    // desktop notification when Claude needs you, and an opt-in webhook POST.
    // Suppressed while paused / privacy=hidden — those snooze the card, and a
    // toast or webhook leaking the project name would defeat that.
    fireStatusSideEffects(resolved, suppressed);

    if (suppressed) {
      const stamp = 'cleared';
      if (lastPayloadHash === stamp) return;
      lastPayloadHash = stamp;
      // Wipe effectiveSessionStart so the next active push gets a fresh
      // elapsed timer rather than counting from a previous session.
      effectiveSessionStart = null;
      await client.user.clearActivity();
      const reason = pausedUntil
        ? `paused until ${new Date(pausedUntil).toLocaleTimeString()}`
        : privacyHidden ? 'privacy=hidden in this project' : 'stale — Claude Code not running';
      log(`Presence cleared (${reason})`);
      return;
    }

    const activity = buildActivity({ resolved });
    const hash = JSON.stringify(activity);
    if (hash === lastPayloadHash) return;
    lastPayloadHash = hash;
    await client.user.setActivity(activity);
    log('Presence updated:', activity.details || '-', '|', activity.state || '-');
  } catch (e) {
    log('setActivity failed:', e.message, '|', e.stack?.split('\n').slice(0, 3).join(' | '));
    // A failed setActivity usually means the IPC pipe died WITHOUT the client
    // emitting a 'disconnected' event (Discord restart, socket reset, OS
    // sleep). Left alone, `connected` stays true and the daemon goes silently
    // dark forever. Tear the client down and force a backoff reconnect so we
    // self-heal. Guarded to connection-shaped errors so a one-off API hiccup
    // doesn't needlessly bounce a healthy socket.
    if (isConnectionError(e)) {
      log('setActivity error looks connection-level — forcing reconnect');
      connected = false;
      lastPayloadHash = '';
      try { client?.destroy(); } catch { /* already gone */ }
      scheduleReconnect('setActivity failed');
    }
  }
}

// Heuristic: does this error indicate the IPC transport itself is dead
// (vs. a transient/application-level failure)? Matches the common broken-pipe
// / closed-socket shapes from our IPC client (src/discord-ipc.js) and the net
// socket so we only force a reconnect when the connection is actually gone.
function isConnectionError(e) {
  const code = (e && e.code) || '';
  // ETIMEDOUT: request() now deadlines nonce replies — a half-open pipe that
  // acks writes but never answers is a dead transport, so reconnect.
  if (['EPIPE', 'ECONNRESET', 'ENOENT', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_STREAM_WRITE_AFTER_END'].includes(code)) return true;
  const m = String((e && e.message) || '').toLowerCase();
  return /closed|reset|broken pipe|not connected|disconnect|write after end|socket|econnreset|epipe|connection/.test(m);
}

async function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // While login() is in flight, connected===false and reconnectTimer===null
  // both hold, so the watchdog's "down, nothing pending" branch would spawn a
  // second connect() that overwrites `client` and orphans this socket. Block it.
  connecting = true;
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
  } finally {
    connecting = false;
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
  // Single source of truth for every on-disk change the daemon reacts to.
  // Each target is covered two ways at once: a directory watcher (instant)
  // and the mtime-poll fallback below (never misses). See watch-poll.js for
  // why both exist — fs.watch drops atomic-rename events on Windows, and
  // every writer here (state.js, pause.js, the scanner, the settings GUI)
  // commits via tmp+rename.
  const targets = [
    { path: STATE_PATH, label: 'state', onChange: pushPresence },
    { path: PAUSE_PATH, label: 'pause', onChange: pushPresence },
    { path: CONFIG_PATH, label: 'config', onChange: () => {
      log('Config changed — reloading');
      config = loadConfigWithLog();
      lastPayloadHash = '';
      pushPresence();
    } },
    { path: AGGREGATE_PATH, label: 'aggregate', onChange: () => {
      aggregate = readAggregate() || aggregate;
      lastPayloadHash = '';
      pushPresence();
    } },
  ];

  // Last mtime we've reacted to, per target. Updated by BOTH the watcher and
  // the poll, so a change one path already handled resolves to a no-op for
  // the other (pollDecision → 'idle') instead of a duplicate push — and the
  // poll only logs a "fallback caught it" line for events the watcher truly
  // missed, not for everything it already handled.
  const lastMtime = new Map();
  const recordMtime = (path) => {
    try { if (existsSync(path)) lastMtime.set(path, statSync(path).mtimeMs); }
    catch { /* mid-rename; a later observation records it */ }
  };
  // Seed baselines so the first poll tick doesn't fire for files that merely
  // already existed when the daemon started.
  targets.forEach((t) => recordMtime(t.path));

  const fire = (t, viaPoll) => {
    if (viaPoll) log(`${t.label} changed — poll fallback caught an event fs.watch missed`);
    recordMtime(t.path); // record before onChange so a re-entrant tick can't double-fire
    t.onChange();
  };

  // Watch DIRECTORIES, not files: every writer uses tmp+rename and inotify
  // tracks the inode, so a file-path watcher goes silent after the first
  // rename. A dir watcher survives renames and works before the file exists
  // (fresh install — daemon up before the first hook seeds state/config).
  // Group by directory so STATE_DIR (state.json + pause.json) takes one
  // watcher, not two. Events are filtered by filename where the platform
  // reports one; a null filename fans out to the whole group (one debounced
  // push per target, deduped by the payload hash).
  const groups = new Map();
  for (const t of targets) {
    const dir = dirname(t.path);
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(t);
  }
  for (const [dir, group] of groups) {
    if (!existsSync(dir)) continue;
    const byName = new Map(group.map((t) => [basename(t.path), t]));
    let timer = null;
    try {
      watch(dir, (event, filename) => {
        const hits = filename ? (byName.has(filename) ? [byName.get(filename)] : []) : group;
        if (!hits.length) return;
        clearTimeout(timer);
        timer = setTimeout(() => hits.forEach((t) => fire(t, false)), 250);
      });
    } catch (e) {
      log(`watch failed for ${dir} (poll fallback still covers it):`, e.message);
    }
  }

  // Mtime-poll fallback. Runs fast on Windows (where it's effectively the
  // primary path — fs.watch drops atomic-rename events there) and lazily on
  // macOS/Linux. Now covers config.json and pause.json too: a dropped
  // pause/config event previously had no backstop at all and could hang
  // until the next unrelated state change.
  setInterval(() => {
    for (const t of targets) {
      let cur;
      try { cur = existsSync(t.path) ? statSync(t.path).mtimeMs : undefined; }
      catch { continue; /* mid-rename; next tick picks it up */ }
      const decision = pollDecision(lastMtime.get(t.path), cur);
      if (decision === 'seed') lastMtime.set(t.path, cur);
      else if (decision === 'fire') fire(t, true);
    }
  }, pollIntervalMs());
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

// ── Connection watchdog (auto-heal) ──────────────────────────────────────────
// The reconnect path is event-driven (the 'disconnected' handler + login
// failures + setActivity errors). But a connection can rot in ways that emit
// no event at all: a half-open client where `connected` is still true but the
// user handle is gone, or a state where we're down with no retry in flight.
// This periodic check guarantees the daemon always converges back to a live
// connection instead of silently staying dark — the single most common
// "it just stopped showing up" failure users hit.
const HEALTH_CHECK_MS = 30_000;
setInterval(() => {
  try {
    // Half-open: flag says connected but there's no usable user handle.
    if (connected && !client?.user && !connecting) {
      log('Watchdog: connected but no user handle — forcing reconnect');
      connected = false;
      try { client?.destroy(); } catch { /* already gone */ }
      scheduleReconnect('watchdog: half-open');
      return;
    }
    // Down with nothing scheduled to bring us back. scheduleReconnect is a
    // no-op when a timer is already pending, so this can't stack retries.
    if (!connected && !reconnectTimer && !connecting) {
      log('Watchdog: disconnected with no reconnect pending — forcing reconnect');
      scheduleReconnect('watchdog: no retry pending');
    }
  } catch (e) {
    log('Watchdog tick failed:', e.message);
  }
}, HEALTH_CHECK_MS);

// Community-totals flush. Disabled by default; turns on via
// `claude-rpc community on`. Best-effort — flushCommunity swallows every
// failure mode, so a flaky endpoint or no network just means the deltas
// pile up locally until the next successful flush. Cadence is config-
// driven (`community.flushIntervalMin`, default 30 min).
async function runCommunityFlush() {
  // Both flushes self-guard (return {ok:false, reason:'disabled'} when their
  // opt-in is off), so run whichever is enabled. The profile flush is
  // independent of community totals but reuses the same anonymous instanceId.
  if (!config.community?.enabled && !config.profile?.enabled) return;
  try {
    const { flushCommunity, flushProfile } = await import('./community.js');
    if (config.community?.enabled) {
      const result = await flushCommunity(config);
      if (result.ok && result.delta) {
        log(`community: flushed +${result.delta.sessions} sessions, +${result.delta.tokens} tokens`);
      } else if (!result.ok && result.reason !== 'rate-limited' && result.reason !== 'no-delta') {
        log(`community: ${result.reason}${result.error ? ' (' + result.error + ')' : ''}`);
      }
    }
    if (config.profile?.enabled) {
      const pr = await flushProfile(config);
      if (pr.ok && pr.totals) {
        log(`profile: published @${config.profile.handle} (${pr.totals.tokens} tokens)`);
      } else if (!pr.ok && pr.reason !== 'rate-limited' && pr.reason !== 'disabled') {
        log(`profile: ${pr.reason}${pr.error ? ' (' + pr.error + ')' : ''}`);
      }
    }
  } catch (e) {
    log('community/profile flush threw:', e.message);
  }
}
const communityFlushMs = Math.max(60_000, (config.community?.flushIntervalMin || 30) * 60 * 1000);
setInterval(runCommunityFlush, communityFlushMs);

// Subscription-usage poll (feeds {usageWeeklyPct} & friends + `claude-rpc
// usage`). Only while something is live — no point burning requests against
// an idle account — and backs off to hourly retries after a bad run, since
// the endpoint is internal and deserves politeness. pollUsage never throws.
let usageFailStreak = 0;
let usageSkipUntil = 0;
async function runUsagePoll() {
  if (config.usage?.enabled === false) return;
  if (Date.now() < usageSkipUntil) return;
  try {
    if (!findLiveSessions({ thresholdMs: 30 * 60_000 }).length) return;
  } catch { /* detection hiccup — poll anyway */ }
  try {
    const r = await pollUsage(config);
    if (r.ok) {
      usageFailStreak = 0;
      log(`usage: session ${r.usage.sessionPct}% · week ${r.usage.weeklyPct}%`);
    } else if (r.reason !== 'disabled') {
      usageFailStreak += 1;
      log(`usage: ${r.reason}${r.error ? ' (' + r.error + ')' : ''}`);
      if (usageFailStreak >= 3) {
        usageSkipUntil = Date.now() + 60 * 60_000;
        usageFailStreak = 0;
      }
    }
  } catch (e) {
    log('usage poll threw:', e.message);
  }
}
const usagePollMs = Math.max(5 * 60_000, (config.usage?.pollIntervalMin || 10) * 60_000);
setInterval(runUsagePoll, usagePollMs);
// First poll shortly after startup so the frame doesn't wait a full interval.
setTimeout(runUsagePoll, 15_000);
// Initial flush after a short delay — gives the scan above a chance to
// build aggregate.json before we ask community.js to read it.
setTimeout(runCommunityFlush, 60_000);
