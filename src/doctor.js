// `claude-rpc doctor` — one-shot diagnostic.
//
// Checks every common failure path users have hit in support and prints a
// colored pass/fail/warn checklist with one-line fix hints. Self-contained:
// no Discord IPC connection (just a brief probe), no side effects, safe to
// run repeatedly. Exit code 0 when everything passes, 1 when any check fails.

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  IS_PACKAGED, IS_NPM_INSTALL, IS_INSTALLED,
  CONFIG_PATH, CANONICAL_EXE, USER_CONFIG_DIR,
  STATE_PATH, PID_PATH, LOG_PATH,
  AGGREGATE_PATH, SCAN_CACHE_PATH,
  CLAUDE_HOME, CLAUDE_PROJECTS, CLAUDE_SETTINGS,
} from './paths.js';
import { findLiveSessions } from './scanner.js';
import { detectGithubUrl } from './git.js';
import { resolveVisibility, listPrivateCwds, detectGithubPrivate } from './privacy.js';
import { readClaudeCredentials, readUsageCache } from './usage.js';
import { EVENTS as HOOK_EVENTS, isOurHook } from './install.js';
import { c, check as uiCheck } from './ui.js';

const counters = { pass: 0, fail: 0, warn: 0 };

// Structured, machine-readable record of every non-passing check that has a
// known repair, so `doctor --fix` can apply ONLY what's actually broken
// (targeted) instead of blindly re-running the whole setup. Each fixable check
// passes a `fixKind` — the CLI maps those to concrete repair actions.
//   'setup'   — re-seed/migrate config + re-wire hooks (runInstall)
//   'daemon'  — (re)start the daemon / clear a stale pid
//   'rescan'  — rebuild the aggregate from transcripts
//   'discord' — not auto-fixable (user must open Discord desktop); advice only
let findings = [];

// Thin wrapper around the shared ui.check so we can keep counters local
// to this module without exporting a stateful version from ui.js.
function check(label, status, detail = '', hint = '', fixKind = null) {
  if      (status === 'pass') counters.pass++;
  else if (status === 'fail') counters.fail++;
  else if (status === 'warn') counters.warn++;
  if (fixKind && status !== 'pass') findings.push({ label, status, fixKind });
  uiCheck(label, status, detail, hint);
}

// Deduped, ordered list of repairs the last runDoctor() identified. Consumed by
// the CLI's `--fix` path. Order matters: config/hooks before daemon (the daemon
// must restart to pick up rewired hooks), aggregate last.
export function fixPlan() {
  const order = ['setup', 'rescan', 'daemon', 'discord'];
  const kinds = new Set(findings.filter((f) => f.fixKind).map((f) => f.fixKind));
  return order.filter((k) => kinds.has(k));
}

function section(title) {
  console.log(`\n  ${c.bold}${title}${c.reset}`);
}

// ── individual checks ────────────────────────────────────────────────────

function checkNodeVersion() {
  const major = Number((process.versions.node || '').split('.')[0] || 0);
  if (major >= 18) {
    check('Node.js version', 'pass', `${process.versions.node}`);
  } else {
    check('Node.js version', 'fail', `${process.versions.node} (need ≥18)`,
      'install a newer Node from https://nodejs.org');
  }
}

function checkMode() {
  let mode, detail;
  if (IS_PACKAGED) {
    mode = 'pass';
    detail = `packaged exe at ${process.execPath}`;
  } else if (IS_NPM_INSTALL) {
    mode = 'pass';
    detail = 'npm install (global or local node_modules)';
  } else {
    mode = 'pass';
    detail = 'dev source (cloned repo, no node_modules wrapper)';
  }
  check('execution mode', mode, detail);
}

// Pure classifiers — extracted so doctor's decision logic is unit-testable
// without spawning the full filesystem diagnostic. The check* wrappers below
// pair these with the actual reads + check() output.
const PLACEHOLDER_CLIENT_ID = '1234567890123456789';

// '' / the seed placeholder → 'unset'; not a 17–21 digit snowflake → 'malformed'.
export function classifyClientId(clientId) {
  if (!clientId || clientId === PLACEHOLDER_CLIENT_ID) return 'unset';
  if (!/^\d{17,21}$/.test(String(clientId))) return 'malformed';
  return 'ok';
}

// Most-recent-wins IPC state inferred from the daemon log tail: 'up'/'down'/'unknown'.
export function ipcStateFromLog(logText) {
  let ipc = 'unknown';
  for (const line of String(logText || '').split('\n').slice(-80)) {
    if (/Discord RPC connected|Presence updated|Presence cleared/i.test(line)) ipc = 'up';
    else if (/retry in \d+s|login failed|Discord disconnected/i.test(line)) ipc = 'down';
  }
  return ipc;
}

function checkConfig() {
  if (!existsSync(CONFIG_PATH)) {
    check('config.json present', 'fail', CONFIG_PATH,
      'run `claude-rpc setup` to seed a default config', 'setup');
    return null;
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    check('config.json present', 'fail', `parse error: ${e.message}`,
      `open ${CONFIG_PATH} and fix the JSON syntax (or delete it and re-run setup)`);
    return null;
  }
  check('config.json present', 'pass', CONFIG_PATH);

  const clientIdClass = classifyClientId(cfg.clientId);
  if (clientIdClass === 'unset') {
    check('discord clientId set', 'fail', cfg.clientId || '(empty)',
      `paste your discord application ID into ${CONFIG_PATH}`);
  } else if (clientIdClass === 'malformed') {
    check('discord clientId set', 'warn', `${cfg.clientId} doesn't look like a snowflake`,
      'discord application IDs are 17–21 digits');
  } else {
    check('discord clientId set', 'pass', String(cfg.clientId));
  }

  const hasByStatus = !!cfg.presence?.byStatus;
  const hasRotation = Array.isArray(cfg.presence?.rotation) && cfg.presence.rotation.length > 0;
  if (hasByStatus) {
    check('presence schema', 'pass', 'byStatus block present (v0.3.6+ shape)');
  } else if (hasRotation) {
    check('presence schema', 'warn', 'legacy rotation only — no byStatus block',
      'run `claude-rpc setup` again to migrate config into the byStatus shape', 'setup');
  } else {
    check('presence schema', 'warn', 'no presence templates configured',
      'either rotation or byStatus is needed for the card to render', 'setup');
  }
  return cfg;
}

function checkClaudeHome() {
  if (!existsSync(CLAUDE_HOME)) {
    check('~/.claude exists', 'fail', CLAUDE_HOME,
      'install claude code first — https://claude.com/claude-code');
    return false;
  }
  check('~/.claude exists', 'pass', CLAUDE_HOME);
  return true;
}

function checkClaudeProjects() {
  if (!existsSync(CLAUDE_PROJECTS)) {
    check('~/.claude/projects exists', 'warn', 'no transcripts on disk yet',
      'open claude code and prompt once — the directory is created lazily');
    return 0;
  }
  let count = 0;
  try {
    for (const proj of readdirSync(CLAUDE_PROJECTS)) {
      for (const f of readdirSync(join(CLAUDE_PROJECTS, proj))) {
        if (f.endsWith('.jsonl')) count++;
      }
    }
  } catch { /* unreadable subdir — just report whatever we counted so far */ }
  check('claude transcripts visible', count > 0 ? 'pass' : 'warn',
    `${count} .jsonl ${count === 1 ? 'file' : 'files'}`,
    count === 0 ? 'open claude code and send a prompt — transcripts appear immediately' : '');
  return count;
}

function checkHooks() {
  if (!existsSync(CLAUDE_SETTINGS)) {
    check('hooks registered', 'fail', `${CLAUDE_SETTINGS} missing`,
      'run `claude-rpc setup` to register hooks');
    return;
  }
  let settings;
  try {
    settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'));
  } catch (e) {
    check('hooks registered', 'fail', `parse error: ${e.message}`,
      `open ${CLAUDE_SETTINGS} and fix the JSON syntax`);
    return;
  }
  const missing = [];
  const stale = [];
  for (const event of HOOK_EVENTS) {
    const bucket = settings.hooks?.[event];
    if (!Array.isArray(bucket) || bucket.length === 0) { missing.push(event); continue; }
    const ours = bucket.flatMap((e) => e.hooks || []).find((h) => isOurHook(h));
    if (!ours) { missing.push(event); continue; }
    if (IS_PACKAGED && !ours.command.includes(CANONICAL_EXE)) stale.push({ event, cmd: ours.command });
    if (IS_NPM_INSTALL && !/\bclaude-rpc\b\s+hook\b/.test(ours.command)) stale.push({ event, cmd: ours.command });
  }
  if (missing.length === 0 && stale.length === 0) {
    check(`hooks registered (${HOOK_EVENTS.length}/${HOOK_EVENTS.length})`, 'pass',
      'all events wired against the current binary');
  } else if (missing.length === HOOK_EVENTS.length) {
    check('hooks registered', 'fail', 'no claude-rpc hooks found',
      'run `claude-rpc setup` to register hooks', 'setup');
  } else if (missing.length > 0) {
    check('hooks registered', 'warn', `missing: ${missing.join(', ')}`,
      'run `claude-rpc setup` to add the missing events', 'setup');
  } else if (stale.length > 0) {
    check('hooks registered', 'warn',
      `${stale.length} pointing at an old binary path`,
      'run `claude-rpc setup` to refresh hook commands against the current binary', 'setup');
  }
}

function checkCanonicalExe() {
  if (!IS_PACKAGED) {
    check('canonical exe', 'pass', `not applicable (${IS_NPM_INSTALL ? 'npm' : 'dev'} mode)`);
    return;
  }
  if (existsSync(CANONICAL_EXE)) {
    let size = '';
    try { size = `${(statSync(CANONICAL_EXE).size / 1024 / 1024).toFixed(1)} MB`; } catch { /* stat failed, size stays blank */ }
    check('canonical exe installed', 'pass', `${CANONICAL_EXE} (${size})`);
  } else {
    check('canonical exe installed', 'fail', `missing: ${CANONICAL_EXE}`,
      'run `claude-rpc setup` to copy this binary to the canonical location', 'setup');
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function checkDaemon() {
  if (!existsSync(PID_PATH)) {
    check('daemon running', 'warn', 'no pid file',
      'run `claude-rpc start` to launch the daemon', 'daemon');
    return false;
  }
  const pid = Number(readFileSync(PID_PATH, 'utf8'));
  if (!pid || !isAlive(pid)) {
    check('daemon running', 'fail', `stale pid file (${pid})`,
      'run `claude-rpc start` — old daemon died without cleaning up', 'daemon');
    return false;
  }
  check('daemon running', 'pass', `pid ${pid}`);
  return true;
}

function checkDaemonLog() {
  if (!existsSync(LOG_PATH)) {
    check('daemon log', 'warn', 'no log file yet',
      'daemon will create this on first start');
    return;
  }
  let st;
  try { st = statSync(LOG_PATH); } catch {
    check('daemon log', 'warn', 'unreadable');
    return;
  }
  const ageMin = (Date.now() - st.mtimeMs) / 60_000;
  const sizeKB = (st.size / 1024).toFixed(1);
  // Infer live IPC state from the log. The daemon connects once and stays
  // connected without re-logging, so grepping only for "connected" produces
  // a false warning on a long-lived daemon. Instead: "Discord RPC connected",
  // "Presence updated", and "Presence cleared" all imply a live connection —
  // the latter two only log *after* the daemon's `connected` guard passes and
  // a setActivity/clearActivity succeeds (see daemon.js). A later "retry in
  // Ns" / "login failed" / "disconnected" line means it dropped. Whichever
  // happened most recently wins.
  let ipc = 'unknown';
  try { ipc = ipcStateFromLog(readFileSync(LOG_PATH, 'utf8')); }
  catch { /* log unreadable — ipc stays 'unknown', warn renders */ }
  if (ipc === 'up') {
    check('discord IPC connection', 'pass',
      `connected · ${sizeKB} KB log · last write ${ageMin.toFixed(1)} min ago`);
  } else if (ipc === 'down') {
    check('discord IPC connection', 'warn', 'daemon is reconnecting to Discord',
      'is the discord desktop client running? rpc only works via desktop, not browser', 'discord');
  } else {
    check('discord IPC connection', 'warn', 'no connection activity in the log yet',
      'start the daemon with discord desktop running');
  }
}

function checkState() {
  if (!existsSync(STATE_PATH)) {
    check('state.json', 'warn', 'not present', 'created by the first hook event');
    return;
  }
  let state;
  try { state = JSON.parse(readFileSync(STATE_PATH, 'utf8')); }
  catch (e) {
    check('state.json', 'fail', `parse error: ${e.message}`,
      `delete ${STATE_PATH} and let the next hook event recreate it`);
    return;
  }
  const ageMin = state.lastActivity
    ? (Date.now() - state.lastActivity) / 60_000
    : Infinity;
  const ageLabel = ageMin === Infinity ? 'never' : `${ageMin.toFixed(1)} min ago`;
  check('state.json fresh', 'pass', `status=${state.status} · last activity ${ageLabel}`);
}

function checkAggregate() {
  if (!existsSync(AGGREGATE_PATH)) {
    check('aggregate built', 'warn', 'never scanned',
      'run `claude-rpc scan` to build lifetime stats from your transcripts', 'rescan');
    return;
  }
  try {
    const agg = JSON.parse(readFileSync(AGGREGATE_PATH, 'utf8'));
    const hours = ((agg.activeMs || 0) / 3_600_000).toFixed(1);
    const ageMin = (Date.now() - statSync(AGGREGATE_PATH).mtimeMs) / 60_000;
    check('aggregate built', 'pass',
      `${agg.sessions || 0} sessions · ${hours}h · refreshed ${ageMin.toFixed(0)} min ago`);
  } catch (e) {
    check('aggregate built', 'fail', `parse error: ${e.message}`,
      'run `claude-rpc rescan` to rebuild the aggregate from scratch', 'rescan');
  }
}

function checkPrivacy(cfg) {
  try {
    const cwd = process.cwd();
    const { visibility, projectName, reason } = resolveVisibility(cwd, cfg || {});
    const listed = listPrivateCwds();
    const detail = projectName
      ? `${visibility}  ·  alias=${projectName}  ·  ${reason}`
      : `${visibility}  ·  ${reason}`;
    const status = visibility === 'hidden' ? 'warn'
                 : visibility === 'name-only' ? 'warn'
                 : 'pass';
    check('current directory visibility', status, detail);
    if (listed.length) {
      check('private-list entries', 'pass', `${listed.length} ${listed.length === 1 ? 'path' : 'paths'} marked private`);
    } else {
      check('private-list entries', 'pass', 'none');
    }
    // Private-repo guard. The "View on GitHub →" button URL is read from
    // .git/config (no gh needed), but auto-hiding a PRIVATE repo needs the gh
    // CLI. On a github repo here where the button would show (public verdict,
    // button enabled) and gh can't answer, a private repo's link could leak.
    const ghUrl = detectGithubUrl(cwd);
    if (ghUrl && visibility === 'public' && cfg?.presence?.githubButton !== false
        && cfg?.privacy?.autoDetectGithubPrivate !== false
        && detectGithubPrivate(cwd) === null) {
      check('private-repo guard', 'warn',
        'gh CLI unavailable — a private repo here can\'t be auto-detected, so its GitHub link may appear on the card',
        'run `gh auth login`, set presence.githubButton:false, or `claude-rpc private` in private repos');
    }
  } catch (e) {
    check('privacy check', 'warn', `lookup failed: ${e.message}`);
  }
}

function checkLiveSessions() {
  try {
    const live = findLiveSessions({ thresholdMs: 90_000 });
    if (live.length === 0) {
      check('live sessions', 'pass',
        'none — claude code isn\'t actively writing a transcript right now');
    } else {
      const names = live.slice(0, 3).map((s) => `${s.project}(${s.ageSec}s)`).join(', ');
      check('live sessions', 'pass', `${live.length} active: ${names}`);
    }
  } catch (e) {
    check('live sessions', 'warn', `lookup failed: ${e.message}`);
  }
}

// Subscription-usage polling (src/usage.js). Three healthy non-pass states
// exist — disabled, no OAuth credentials, daemon hasn't polled yet — so only
// the last is a warn; the others are informational.
function checkUsage(cfg) {
  if (cfg?.usage?.enabled === false) {
    check('usage polling', 'info', 'disabled in config (usage.enabled: false)');
    return;
  }
  const creds = readClaudeCredentials();
  if (!creds) {
    check('usage polling', 'info',
      'no Claude Code OAuth credentials — subscription limits unavailable (API-key install?)');
    return;
  }
  const u = readUsageCache();
  if (u) {
    // Either bucket can be null (they come and go between Claude Code
    // releases); interpolating both unconditionally printed a literal `null%`.
    const parts = [];
    if (u.weeklyPct != null) parts.push(`week ${u.weeklyPct}%`);
    if (u.sessionPct != null) parts.push(`session ${u.sessionPct}%`);
    parts.push(`fetched ${Math.max(0, Math.round((Date.now() - u.fetchedAt) / 60_000))} min ago`);
    check('usage polling', 'pass', parts.join(' · '));
  } else {
    check('usage polling', 'warn', 'no fresh usage data yet',
      'the daemon polls every 10 min while a session is live — or run `claude-rpc usage` for a live fetch');
  }
}

function checkDataDir() {
  if (!existsSync(USER_CONFIG_DIR)) {
    check('user config dir', 'warn', `${USER_CONFIG_DIR} missing`,
      'run `claude-rpc setup` — this is created automatically', 'setup');
    return;
  }
  check('user config dir', 'pass', USER_CONFIG_DIR);
}

// ── public entry point ──────────────────────────────────────────────────

export function runDoctor() {
  counters.pass = 0; counters.fail = 0; counters.warn = 0;
  findings = [];
  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ doctor${c.reset}  ${c.dim}— diagnostic checklist${c.reset}`);

  section('Runtime');
  checkNodeVersion();
  checkMode();
  checkCanonicalExe();

  section('Config');
  checkDataDir();
  const cfg = checkConfig();

  section('Claude Code');
  if (checkClaudeHome()) {
    checkClaudeProjects();
    checkHooks();
  }

  section('Daemon');
  checkDaemon();
  checkDaemonLog();
  checkState();

  section('Data');
  checkAggregate();
  checkLiveSessions();
  checkUsage(cfg);

  section('Privacy');
  checkPrivacy(cfg);

  // Summary
  const { pass, fail, warn } = counters;
  console.log('');
  console.log(`  ${c.bold}Summary:${c.reset}  ${c.green}${pass} pass${c.reset}` +
    (warn ? `  ${c.yellow}${warn} warn${c.reset}` : '') +
    (fail ? `  ${c.red}${fail} fail${c.reset}` : ''));
  if (fail === 0 && warn === 0) {
    console.log(`  ${c.dim}everything looks good. if presence still isn't showing, restart discord.${c.reset}`);
  } else if (fail === 0) {
    console.log(`  ${c.dim}no failures — warnings are usually fixed by running \`claude-rpc setup\`.${c.reset}`);
  }
  console.log('');

  return fail === 0 ? 0 : 1;
}
