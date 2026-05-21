#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, unlinkSync, watch, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@xhayper/discord-rpc';
import { readState } from './state.js';
import { buildVars, fillTemplate, framePasses, applyIdle } from './format.js';
import { scan, readAggregate, findLiveSessions } from './scanner.js';
import { CONFIG_PATH, STATE_PATH, PID_PATH, LOG_PATH, STATE_DIR, AGGREGATE_PATH } from './paths.js';

if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  try { appendFileSync(LOG_PATH, line); } catch {}
  process.stdout.write(line);
}

function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { log('Failed to read config.json:', e.message); process.exit(1); }
}

let config = loadConfig();
let aggregate = readAggregate() || null;
let liveSessions = [];
let client = null;
let connected = false;
let lastPayloadHash = '';
let reconnectTimer = null;
let rotationIndex = 0;
let lastRotationAt = 0;
// Stabilizes Discord's elapsed timer: applyIdle can synthesize a sessionStart
// from a moving transcript mtime, and missing-hook scenarios leave it null —
// either case would make startTimestamp jump on every rotation.
let effectiveSessionStart = null;

writeFileSync(PID_PATH, String(process.pid));

// ── GitHub origin auto-detect ────────────────────────────────────────────────
const githubCache = new Map(); // cwd → { url, checkedAt }
const GITHUB_CACHE_TTL = 5 * 60 * 1000;

function detectGithubUrl(cwd) {
  if (!cwd) return null;
  const cached = githubCache.get(cwd);
  if (cached && Date.now() - cached.checkedAt < GITHUB_CACHE_TTL) return cached.url;
  let url = null;
  try {
    const gitCfg = join(cwd, '.git', 'config');
    if (existsSync(gitCfg)) {
      const txt = readFileSync(gitCfg, 'utf8');
      const m = txt.match(/\[remote\s+"origin"\][^\[]*?url\s*=\s*([^\r\n]+)/i);
      if (m) {
        let raw = m[1].trim();
        // SSH form: git@github.com:user/repo(.git)? → https
        const ssh = raw.match(/^git@github\.com:([^\s]+?)(?:\.git)?$/i);
        if (ssh) url = `https://github.com/${ssh[1]}`;
        // HTTPS form: keep as-is, strip trailing .git
        else if (/^https?:\/\/github\.com\//i.test(raw)) url = raw.replace(/\.git$/i, '');
      }
    }
  } catch {}
  githubCache.set(cwd, { url, checkedAt: Date.now() });
  return url;
}

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

function buildActivity(opts = {}) {
  let state = opts.state || readState();
  // Attach live sessions BEFORE applyIdle so the stale/idle decision can
  // see ongoing transcript activity, not just this daemon's hook state.
  state.liveSessions = opts.liveSessions || liveSessions;
  state = applyIdle(state, config);
  const vars = buildVars(state, config, opts.aggregate || aggregate);
  const p = config.presence || {};

  const rawFrames = Array.isArray(p.rotation) && p.rotation.length
    ? p.rotation
    : [{ details: p.details, state: p.state }];

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

  // Image precedence: statusAssets[status] → modelAssets[modelMatch] → presence.largeImageKey.
  // statusAssets lets the user swap the big image based on what Claude is doing
  // (working/thinking/idle/stale/notification).
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
  if (p.largeImageText) activity.largeImageText = fillTemplate(p.largeImageText, vars).slice(0, 128);

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
  // GitHub button when the current cwd has a github origin.
  const buttons = Array.isArray(p.buttons) ? p.buttons.slice() : [];
  const gh = state.status !== 'stale' ? detectGithubUrl(state.cwd) : null;
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

    const hideWhenStale = config.hideWhenStale !== false;
    if (resolved.status === 'stale' && hideWhenStale) {
      const stamp = 'cleared';
      if (lastPayloadHash === stamp) return;
      lastPayloadHash = stamp;
      // Wipe effectiveSessionStart so the next active push gets a fresh
      // elapsed timer rather than counting from a previous session.
      effectiveSessionStart = null;
      await client.user.clearActivity();
      log('Presence cleared (stale — Claude Code not running)');
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
    log('Discord RPC connected as', client.user?.username);
    lastPayloadHash = '';
    pushPresence();
  });
  client.on('disconnected', () => {
    connected = false;
    log('Discord disconnected — retrying in 10s');
    scheduleReconnect();
  });
  try { await client.login(); }
  catch (e) {
    log('Discord login failed:', e.message, '— retrying in 10s. Is Discord desktop running?');
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  connected = false;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 10000);
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
    try { config = loadConfig(); lastPayloadHash = ''; pushPresence(); }
    catch (e) { log('Reload failed:', e.message); }
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
  try { client?.destroy(); } catch {}
  try { if (existsSync(PID_PATH)) unlinkSync(PID_PATH); } catch {}
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

// Live session polling — cheap mtime walk.
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
setInterval(refreshLiveSessions, 5000);
