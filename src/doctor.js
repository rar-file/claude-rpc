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
import { resolveVisibility, listPrivateCwds } from './privacy.js';
import { c, check as uiCheck } from './ui.js';

const counters = { pass: 0, fail: 0, warn: 0 };

// Thin wrapper around the shared ui.check so we can keep counters local
// to this module without exporting a stateful version from ui.js.
function check(label, status, detail = '', hint = '') {
  if      (status === 'pass') counters.pass++;
  else if (status === 'fail') counters.fail++;
  else if (status === 'warn') counters.warn++;
  uiCheck(label, status, detail, hint);
}

function section(title) {
  console.log(`\n${c.bold}${title}${c.reset}`);
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

function checkConfig() {
  if (!existsSync(CONFIG_PATH)) {
    check('config.json present', 'fail', CONFIG_PATH,
      'run `claude-rpc setup` to seed a default config');
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

  if (!cfg.clientId || cfg.clientId === '1234567890123456789') {
    check('discord clientId set', 'fail', cfg.clientId || '(empty)',
      `paste your discord application ID into ${CONFIG_PATH}`);
  } else if (!/^\d{17,21}$/.test(String(cfg.clientId))) {
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
      'run `claude-rpc setup` again to migrate config into the byStatus shape');
  } else {
    check('presence schema', 'warn', 'no presence templates configured',
      'either rotation or byStatus is needed for the card to render');
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

const HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'SubagentStop', 'Notification', 'SessionEnd',
];

function isOurHookCommand(cmd) {
  if (!cmd) return false;
  return /claude-rpc/i.test(cmd) || /hook\.js/i.test(cmd);
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
    const ours = bucket.flatMap((e) => e.hooks || []).find((h) => isOurHookCommand(h.command));
    if (!ours) { missing.push(event); continue; }
    if (IS_PACKAGED && !ours.command.includes(CANONICAL_EXE)) stale.push({ event, cmd: ours.command });
    if (IS_NPM_INSTALL && !/\bclaude-rpc\b\s+hook\b/.test(ours.command)) stale.push({ event, cmd: ours.command });
  }
  if (missing.length === 0 && stale.length === 0) {
    check(`hooks registered (${HOOK_EVENTS.length}/${HOOK_EVENTS.length})`, 'pass',
      'all events wired against the current binary');
  } else if (missing.length === HOOK_EVENTS.length) {
    check('hooks registered', 'fail', 'no claude-rpc hooks found',
      'run `claude-rpc setup` to register hooks');
  } else if (missing.length > 0) {
    check('hooks registered', 'warn', `missing: ${missing.join(', ')}`,
      'run `claude-rpc setup` to add the missing events');
  } else if (stale.length > 0) {
    check('hooks registered', 'warn',
      `${stale.length} pointing at an old binary path`,
      'run `claude-rpc setup` to refresh hook commands against the current binary');
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
      'run `claude-rpc setup` to copy this binary to the canonical location');
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function checkDaemon() {
  if (!existsSync(PID_PATH)) {
    check('daemon running', 'warn', 'no pid file',
      'run `claude-rpc start` to launch the daemon');
    return false;
  }
  const pid = Number(readFileSync(PID_PATH, 'utf8'));
  if (!pid || !isAlive(pid)) {
    check('daemon running', 'fail', `stale pid file (${pid})`,
      'run `claude-rpc start` — old daemon died without cleaning up');
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
  // Look for "Discord RPC connected" in the tail to confirm Discord IPC.
  let connected = false;
  try {
    const tail = readFileSync(LOG_PATH, 'utf8').split('\n').slice(-50).join('\n');
    connected = /Discord RPC connected/i.test(tail);
  } catch { /* log unreadable — connected stays false, warn check renders */ }
  if (connected) {
    check('discord IPC connection', 'pass',
      `${sizeKB} KB log · last write ${ageMin.toFixed(1)} min ago`);
  } else {
    check('discord IPC connection', 'warn',
      `log shows no recent "connected" line`,
      'is the discord desktop client running? rpc only works via desktop, not browser');
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
      'run `claude-rpc scan` to build lifetime stats from your transcripts');
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
      'run `claude-rpc rescan` to rebuild the aggregate from scratch');
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

function checkDataDir() {
  if (!existsSync(USER_CONFIG_DIR)) {
    check('user config dir', 'warn', `${USER_CONFIG_DIR} missing`,
      'run `claude-rpc setup` — this is created automatically');
    return;
  }
  check('user config dir', 'pass', USER_CONFIG_DIR);
}

// ── public entry point ──────────────────────────────────────────────────

export function runDoctor() {
  console.log(`${c.bold}${c.cyan}claude-rpc doctor${c.reset}  ${c.dim}— diagnostic checklist${c.reset}`);

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
