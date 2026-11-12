// Settings API for the local dashboard's /settings page — the config editor,
// daemon controls and per-project privacy that used to live in a separate
// Electron app. Everything here runs in-process against the same modules the
// CLI uses, so the page and `claude-rpc start|stop|private` can't disagree.
//
// Routes (registered in routes.js):
//   GET  /api/settings     effective config + daemon status + template vars
//   POST /api/settings     { base, edited } → write only what changed
//   POST /api/daemon       { action: start|stop|restart }
//   GET  /api/log          tail of daemon.log
//   GET  /api/workspaces   known project dirs + their visibility
//   POST /api/workspaces   { cwd, level }
//
// The write routes are guarded in index.js (same-origin + JSON body), since a
// localhost server is reachable from any page the user has open.

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import { CONFIG_PATH, LOG_PATH, SCAN_CACHE_PATH } from '../paths.js';
import { DEFAULT_CONFIG } from '../default-config.js';
import { loadConfig, mergeConfig } from '../config.js';
import { applyEdits } from '../config-edit.js';
import { writeFileAtomic } from '../atomic-rename.js';
import { daemonAlive, spawnDaemonDetached } from '../ensure-daemon.js';
import { ipcStateFromLog, bridgeFromLog, classifyClientId } from '../doctor.js';
import { readActiveState } from '../state.js';
import { findLiveSessions, readAggregate } from '../scanner.js';
import { buildVars, applyIdle } from '../format.js';
import { readUsageCache } from '../usage.js';
import { listVisibility, setCwdVisibility } from '../privacy.js';
import { VERSION } from '../version.js';

// Every status the card can render, in the order the page lists them.
export const STATUSES = ['working', 'thinking', 'compacting', 'shipped', 'notification', 'idle'];
const VIS_LEVELS = ['public', 'name-only', 'hidden'];
const MAX_CONFIG_BYTES = 256 * 1024;

// Write routes change the user's config and start/stop their daemon, and a
// localhost server is reachable from every page open in the browser. Two
// checks keep other sites out:
//   - Origin, when sent (browsers always send it on POST), must be this exact
//     host:port — not merely "some localhost page".
//   - The body must be application/json. A cross-site form can't send that
//     without a CORS preflight, which this server never answers.
export function writeAllowed(headers) {
  const type = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return false;
  const origin = headers.origin;
  if (origin === undefined) return true; // non-browser client (curl, tests)
  try { return new URL(origin).host === headers.host; } catch { return false; }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function tailLog(lines = 80) {
  try {
    if (!existsSync(LOG_PATH)) return '';
    return readFileSync(LOG_PATH, 'utf8').split('\n').slice(-lines).join('\n').trimEnd();
  } catch { return ''; }
}

// running/pid from the pid file; ipc ('up'|'down'|'unknown') and the client
// kind from the log tail — the same reading `claude-rpc doctor` reports.
export function daemonStatus() {
  const pid = daemonAlive();
  if (!pid) return { running: false, pid: null, ipc: 'down', client: null };
  const log = tailLog(200);
  return { running: true, pid, ipc: ipcStateFromLog(log), client: bridgeFromLog(log) };
}

// Live template variables, for the card preview and the {variable} picker.
function liveVars(config) {
  try {
    let state = readActiveState();
    state.liveSessions = findLiveSessions({ thresholdMs: 90_000 });
    state = applyIdle(state, config);
    state.usage = readUsageCache();
    return buildVars(state, config, readAggregate() || {});
  } catch { return {}; }
}

export function getSettings() {
  const config = loadConfig();
  const live = liveVars(config);
  return {
    version: VERSION,
    configPath: CONFIG_PATH,
    config,
    statuses: STATUSES,
    daemon: daemonStatus(),
    vars: Object.keys(live).sort(),
    live,
  };
}

// The file as it is on disk right now. A missing file is an empty config; an
// unreadable or half-written one throws, because overwriting it would lose
// whatever is in it.
function readRawConfig(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`couldn't read ${path} (${e.message})`, { cause: e });
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { throw new Error(`${path} isn't valid JSON (${e.message}) — fix or delete it first`, { cause: e }); }
  if (!isPlainObject(raw)) throw new Error(`${path} isn't a JSON object`);
  return raw;
}

// Reject edits that would leave the daemon unable to render anything. Kept
// short on purpose: the daemon already tolerates odd values by falling back
// to defaults, so this only catches what would silently break the card.
export function validateConfig(merged) {
  if (classifyClientId(merged.clientId) !== 'ok') {
    return 'Discord application ID must be the 17–21 digit number from the Discord developer portal';
  }
  for (const b of merged.presence?.buttons || []) {
    if (!b || typeof b.label !== 'string' || !/^https?:\/\//i.test(b.url || '')) {
      return 'Each button needs a label and an http(s) link';
    }
  }
  if ((merged.presence?.buttons || []).length > 2) return 'Discord shows at most 2 buttons';
  for (const k of ['updateIntervalMs', 'rotationIntervalMs', 'idleThresholdSec', 'staleSessionMin', 'shippedFrameSec']) {
    const v = merged[k];
    if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      return `${k} must be a number, 0 or more`;
    }
  }
  return null;
}

// { base, edited } → writes only the keys that differ between them onto the
// file as it is on disk now. Returns { ok, config } or { error }.
// `path` is overridable for tests only.
export function saveSettings(body, { path = CONFIG_PATH } = {}) {
  const { base, edited } = body || {};
  if (!isPlainObject(base) || !isPlainObject(edited)) return { error: 'Nothing to save' };
  let raw;
  try { raw = readRawConfig(path); } catch (e) { return { error: `Not saved: ${e.message}` }; }
  const next = applyEdits(raw, base, edited);
  const problem = validateConfig(mergeConfig(DEFAULT_CONFIG, next));
  if (problem) return { error: problem };
  const text = JSON.stringify(next, null, 2) + '\n';
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return { error: 'Config is too large to save' };
  try { writeFileAtomic(path, text); }
  catch (e) { return { error: `Not saved: ${e.message}` }; }
  return { ok: true, config: loadConfig({ path }) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll until the daemon's liveness matches `want` (true = up), or time out.
async function waitDaemon(want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!!daemonAlive() === want) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

function signal(pid, sig) {
  try { process.kill(pid, sig); return true; } catch { return false; }
}

async function stop() {
  const pid = daemonAlive();
  if (!pid) return true;
  signal(pid, 'SIGTERM');
  if (await waitDaemon(false, 3000)) return true;
  // Wedged: it ignored SIGTERM for 3s. Don't leave the user with a daemon
  // they asked to stop.
  signal(pid, 'SIGKILL');
  return waitDaemon(false, 1500);
}

async function start() {
  if (daemonAlive()) return true;
  const child = spawnDaemonDetached();
  if (!child || !child.pid) return false;
  // A detached spawn can die a millisecond later (bad path, startup throw), so
  // confirm through the pid file the daemon claims early in startup.
  return waitDaemon(true, 3000);
}

export async function daemonAction(action) {
  let ok;
  if (action === 'start') ok = await start();
  else if (action === 'stop') ok = await stop();
  else if (action === 'restart') ok = (await stop()) && (await start());
  else return { error: 'unknown action' };
  const daemon = daemonStatus();
  if (ok) return { ok: true, daemon };
  const what = action === 'stop' ? "The daemon didn't stop" : "The daemon didn't come up";
  return { error: `${what} — see the log below`, daemon };
}

export function getLog() {
  return { path: LOG_PATH, content: tailLog(80) };
}

// Project directories the scanner has seen, newest activity first. Read from
// the scan cache (each transcript summary carries its cwd) rather than
// re-walking ~/.claude/projects. Subagent transcripts share their parent's cwd
// and collapse into it.
export function listWorkspaces() {
  const seen = new Map(); // resolved cwd → { name, cwd, lastTs }
  try {
    const cache = JSON.parse(readFileSync(SCAN_CACHE_PATH, 'utf8'));
    for (const f of Object.values(cache.files || {})) {
      if (!f || typeof f.cwd !== 'string' || !f.cwd) continue;
      const cwd = resolvePath(f.cwd);
      const lastTs = Number(f.lastTs) || 0;
      const prev = seen.get(cwd);
      if (!prev || lastTs > prev.lastTs) seen.set(cwd, { name: basename(cwd) || cwd, cwd, lastTs });
    }
  } catch { /* no scan yet — empty list */ }
  return {
    workspaces: [...seen.values()].sort((a, b) => b.lastTs - a.lastTs),
    visibility: listVisibility(),
  };
}

// level: public | name-only | hidden; anything else clears the override.
export function setWorkspaceVisibility(body) {
  const cwd = body && typeof body.cwd === 'string' && body.cwd ? body.cwd : null;
  if (!cwd) return { error: 'no project given' };
  const level = VIS_LEVELS.includes(body.level) ? body.level : null;
  try { return { ok: true, visibility: setCwdVisibility(cwd, level) }; }
  catch (e) { return { error: e.message }; }
}
