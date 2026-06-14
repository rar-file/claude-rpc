// One-shot installer logic invoked by the bundled exe.
// Seeds %APPDATA%\claude-rpc\config.json, points Claude Code's hooks at the
// exe, and registers a Windows startup entry so the daemon comes up on login.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  copyFileSync, chmodSync, renameSync, statSync,
  readdirSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  CLAUDE_SETTINGS, CONFIG_PATH, USER_CONFIG_DIR, ROOT,
  HOOK_SCRIPT, IS_PACKAGED, IS_NPM_INSTALL, IS_NPX,
  CANONICAL_EXE, CANONICAL_INSTALL_DIR, CANONICAL_EXE_NAME,
} from './paths.js';
import { DEFAULT_CONFIG } from './default-config.js';
import { VERSION } from './version.js';
import { c, SYM_OK, SYM_WARN, SYM_FAIL, SYM_INFO, hintLine } from './ui.js';

const STARTUP_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const STARTUP_VALUE = 'ClaudeRPC';

// Setup output is a phased checklist: every row is `sym  label  detail`, with
// the label column fixed-width so the detail column lines up across phases.
// The same rows print standalone (doctor --fix, packaged refresh) and still
// read fine outside the phased layout.
//
// Loud when something changes, near-silent when nothing does: a re-run where
// everything is already in place collapses to ONE summary line instead of
// re-printing the checklist. State-changing steps print rows (flushing their
// pending phase header) and mark the run dirty; confirmations record a
// `noop()` fact for the summary. Failures always print.
const LABEL_W = 16;
let pendingPhase = null;
let runDirty = false;
let noopFacts = [];

function resetRun() { pendingPhase = null; runDirty = false; noopFacts = []; }
function phase(title) { pendingPhase = title; }
function step(sym, label, detail = '', log = console.log) {
  if (pendingPhase) {
    console.log(`\n  ${c.bold}${pendingPhase}${c.reset}`);
    pendingPhase = null;
  }
  log(`  ${sym}  ${label.padEnd(LABEL_W)}${detail ? `${c.dim}${detail}${c.reset}` : ''}`);
}
function dirtyStep(sym, label, detail = '', log = console.log) {
  runDirty = true;
  step(sym, label, detail, log);
}
function noop(fact) { noopFacts.push(fact); }

const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'SubagentStop', 'Notification', 'SessionEnd', 'PreCompact',
];

function readJson(p, fb) {
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { return fb; }
}

function writeJson(p, d) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(d, null, 2));
}

function isOurHookCommand(cmd) {
  if (!cmd) return false;
  return /claude-rpc/i.test(cmd) || /hook\.js/i.test(cmd);
}

export function installHooks(exePath) {
  const settings = readJson(CLAUDE_SETTINGS, {});
  const before = JSON.stringify(settings.hooks || {});
  settings.hooks = settings.hooks || {};
  // Three modes, three shapes:
  //   packaged → `"<exe>" hook <event>`         (canonical exe, no node)
  //   npm     → `claude-rpc hook <event>`       (bin shim resolves through PATH;
  //              survives `npm update` and nvm version switches)
  //   dev     → `node "<src/hook.js>" <event>`  (cloned-source iteration)
  const cmdFor = IS_PACKAGED
    ? (event) => `"${exePath}" hook ${event}`
    : IS_NPM_INSTALL
      ? (event) => `claude-rpc hook ${event}`
      : (event) => `node "${HOOK_SCRIPT.replace(/\\/g, '/')}" ${event}`;

  for (const event of EVENTS) {
    const bucket = settings.hooks[event] = settings.hooks[event] || [];
    const wanted = cmdFor(event);
    const existingEntry = bucket.find((b) =>
      Array.isArray(b.hooks) && b.hooks.some((h) => isOurHookCommand(h.command))
    );
    if (existingEntry) {
      existingEntry.hooks = existingEntry.hooks.map((h) =>
        isOurHookCommand(h.command) ? { ...h, command: wanted } : h
      );
    } else {
      bucket.push({ matcher: '', hooks: [{ type: 'command', command: wanted }] });
    }
  }
  if (JSON.stringify(settings.hooks) === before) {
    noop(`hooks wired (${EVENTS.length} events)`);
    return false;
  }
  writeJson(CLAUDE_SETTINGS, settings);
  dirtyStep(SYM_OK, 'hooks wired', `${EVENTS.length} events → ${CLAUDE_SETTINGS}`);
  return true;
}

export function uninstallHooks() {
  const settings = readJson(CLAUDE_SETTINGS, {});
  if (!settings.hooks) return;
  for (const event of EVENTS) {
    const bucket = settings.hooks[event];
    if (!Array.isArray(bucket)) continue;
    settings.hooks[event] = bucket
      .map((entry) => ({ ...entry, hooks: (entry.hooks || []).filter((h) => !isOurHookCommand(h.command)) }))
      .filter((entry) => (entry.hooks || []).length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  writeJson(CLAUDE_SETTINGS, settings);
  step(SYM_OK, 'hooks removed', CLAUDE_SETTINGS);
}

function regCommand(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('reg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => err += d.toString());
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `reg.exe exit ${code}`)));
  });
}

const STARTUP_VBS = join(CANONICAL_INSTALL_DIR, 'claude-rpc-daemon.vbs');

export async function addStartupEntry(exePath) {
  // The packaged exe is a console-subsystem node.exe, so a bare Run-key entry
  // (`"<exe>" daemon`) makes Explorer pop a console window at every login that
  // persists for the daemon's whole (weeks-long) life — closing it kills the
  // daemon. Launch through a tiny .vbs shim via wscript (window style 0) so the
  // unattended startup path is windowless, like every other launch path. We
  // avoid schtasks deliberately — SECURITY.md advertises "no scheduled task".
  let runCmd = `"${exePath}" daemon`;
  try {
    mkdirSync(CANONICAL_INSTALL_DIR, { recursive: true });
    writeFileSync(STARTUP_VBS, `CreateObject("WScript.Shell").Run """${exePath}"" daemon", 0, False\r\n`);
    runCmd = `wscript.exe "${STARTUP_VBS}"`;
  } catch { /* couldn't write the shim — fall back to the direct (windowed) entry */ }
  await regCommand([
    'add', STARTUP_KEY,
    '/v', STARTUP_VALUE,
    '/t', 'REG_SZ',
    '/d', runCmd,
    '/f',
  ]);
  if (runDirty) step(SYM_OK, 'startup entry', `HKCU\\…\\Run\\${STARTUP_VALUE} — daemon starts at login (windowless)`);
  else noop('startup entry present');
}

export async function removeStartupEntry() {
  try {
    await regCommand(['delete', STARTUP_KEY, '/v', STARTUP_VALUE, '/f']);
    step(SYM_OK, 'startup entry', 'removed');
  } catch {
    // Already absent — fine.
  }
  try { unlinkSync(STARTUP_VBS); } catch { /* shim absent — fine */ }
}

function samePath(a, b) {
  if (!a || !b) return false;
  try {
    const ra = resolve(a);
    const rb = resolve(b);
    return process.platform === 'win32'
      ? ra.toLowerCase() === rb.toLowerCase()
      : ra === rb;
  } catch { return false; }
}

// Best-effort sweep of stale `.old-<ts>` siblings left behind by a prior
// rename-out-of-the-way during an in-place exe replacement.
function sweepStaleCanonicalBackups() {
  try {
    if (!existsSync(CANONICAL_INSTALL_DIR)) return;
    const prefix = CANONICAL_EXE_NAME + '.old-';
    for (const name of readdirSync(CANONICAL_INSTALL_DIR)) {
      if (name.startsWith(prefix)) {
        try { unlinkSync(join(CANONICAL_INSTALL_DIR, name)); } catch { /* file locked or vanished — sweep is best-effort */ }
      }
    }
  } catch { /* install dir unreadable — nothing to sweep */ }
}

// Copy the running binary into CANONICAL_EXE if it's not already there.
// Returns the path that hook entries should point at — canonical on success,
// the original path as a fallback. Only meaningful in packaged mode.
export function ensureCanonicalExe(currentExe) {
  if (!IS_PACKAGED) return currentExe;
  if (samePath(currentExe, CANONICAL_EXE)) return CANONICAL_EXE;
  mkdirSync(CANONICAL_INSTALL_DIR, { recursive: true });

  // Skip the copy when canonical already exists AND matches the source —
  // avoids a needless overwrite (and the Windows running-file gymnastics it
  // can trigger) on repeated `setup` runs from the same launch point.
  if (existsSync(CANONICAL_EXE)) {
    try {
      const src = statSync(currentExe);
      const dst = statSync(CANONICAL_EXE);
      if (src.size === dst.size && Math.abs(src.mtimeMs - dst.mtimeMs) < 2000) {
        noop('exe current');
        return CANONICAL_EXE;
      }
    } catch { /* stat failed — fall through to copy attempt */ }
  }

  try {
    // Windows won't let you overwrite a currently-executing file. If
    // canonical is the running daemon, move it aside first — that succeeds
    // even while the file handle is open, and Windows will delete the
    // renamed copy when the process exits.
    if (process.platform === 'win32' && existsSync(CANONICAL_EXE)) {
      try { renameSync(CANONICAL_EXE, CANONICAL_EXE + '.old-' + Date.now()); }
      catch { /* not running, no rename needed — copyFileSync below will just overwrite */ }
    }
    copyFileSync(currentExe, CANONICAL_EXE);
    if (process.platform !== 'win32') chmodSync(CANONICAL_EXE, 0o755);
    dirtyStep(SYM_OK, 'exe installed', CANONICAL_EXE);
    step(SYM_INFO, 'original copy', `${currentExe} — safe to delete`);
    sweepStaleCanonicalBackups();
    return CANONICAL_EXE;
  } catch (e) {
    step(SYM_WARN, 'exe copy failed', `${CANONICAL_EXE}: ${e.message}`, console.warn);
    hintLine(`falling back to ${currentExe} — if that file moves, run \`claude-rpc setup\` again`, process.stderr);
    return currentExe;
  }
}

export function seedConfig() {
  // npm-install upgrade path: prior v0.3.8 (and earlier) seeded config inside
  // node_modules/claude-rpc/config.json. New shape puts it under USER_CONFIG_DIR.
  // If the legacy file exists and the new one doesn't, copy first so the user
  // doesn't lose their clientId.
  if (IS_NPM_INSTALL) {
    const legacyPath = join(ROOT, 'config.json');
    try {
      if (!existsSync(CONFIG_PATH) && existsSync(legacyPath)) {
        mkdirSync(USER_CONFIG_DIR, { recursive: true });
        copyFileSync(legacyPath, CONFIG_PATH);
        dirtyStep(SYM_OK, 'config migrated', CONFIG_PATH);
        step(SYM_INFO, 'legacy copy', `${legacyPath} — safe to delete on the next npm update`);
        return false;
      }
    } catch (e) {
      step(SYM_WARN, 'config legacy', `migration skipped: ${e.message}`, console.warn);
    }
  }

  if (existsSync(CONFIG_PATH)) {
    noop('config current');
    return false;
  }
  mkdirSync(USER_CONFIG_DIR, { recursive: true });
  // Fresh install: mint an anonymous instanceId so community.enabled:true
  // (the new default in v0.7) is immediately actionable — the daemon needs
  // an id to actually flush. Users who want out: `claude-rpc community off`.
  const seeded = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (seeded.community?.enabled && !seeded.community.instanceId) {
    seeded.community.instanceId = randomUUID();
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(seeded, null, 2));
  dirtyStep(SYM_OK, 'config seeded', CONFIG_PATH);
  if (seeded.community?.enabled && seeded.community.instanceId) {
    step(SYM_INFO, 'community', `anonymous totals on by default · opt out: ${c.reset}${c.cyan}claude-rpc community off`);
  }
  return true;
}

// Non-destructive merge of any new top-level keys / presence blocks the
// shipped DEFAULT_CONFIG has but the user's existing file doesn't.
//
// Runs every time install/setup or the packaged default launcher fires,
// so an upgraded exe pulls in new shape (e.g. v0.3.6's presence.byStatus)
// without clobbering the user's customizations. Anything the user already
// has — including a pre-existing byStatus, custom rotation array, custom
// appName etc. — is left untouched.
// How Claude Code should invoke the MCP server — same three-mode resolution
// as the hook commands (packaged exe / npm bin / dev source).
export function mcpServerCommand(exePath) {
  if (IS_PACKAGED) return { command: exePath, args: ['mcp'] };
  if (IS_NPM_INSTALL) return { command: 'claude-rpc', args: ['mcp'] };
  const cli = join(dirname(HOOK_SCRIPT), 'cli.js').replace(/\\/g, '/');
  return { command: 'node', args: [cli, 'mcp'] };
}

// Register the MCP server with Claude Code via its own `claude mcp add`, so a
// user never has to hand-type the command. Best-effort: returns { ok, reason,
// command, args }. Needs the `claude` CLI on PATH.
export function installMcp({ exePath, scope = 'user' } = {}) {
  const { command, args } = mcpServerCommand(exePath);
  const winShell = process.platform === 'win32';
  // Replace any stale entry first so re-running is idempotent (ignore failure).
  spawnSync('claude', ['mcp', 'remove', 'claude-rpc', '--scope', scope], { stdio: 'ignore', shell: winShell });
  const r = spawnSync('claude', ['mcp', 'add', 'claude-rpc', '--scope', scope, '--', command, ...args], { stdio: 'inherit', shell: winShell });
  if (r.error && r.error.code === 'ENOENT') return { ok: false, reason: 'no-claude', command, args };
  if (r.status !== 0) return { ok: false, reason: 'add-failed', code: r.status, command, args };
  return { ok: true, command, args, scope };
}

export function uninstallMcp({ scope = 'user' } = {}) {
  const r = spawnSync('claude', ['mcp', 'remove', 'claude-rpc', '--scope', scope], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error && r.error.code === 'ENOENT') return { ok: false, reason: 'no-claude' };
  return { ok: r.status === 0 };
}

export function migrateConfig({ silent = false } = {}) {
  if (!existsSync(CONFIG_PATH)) return false;
  let cfg;
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) {
    if (!silent) step(SYM_WARN, 'config migration', `could not read config: ${e.message}`, console.warn);
    return false;
  }
  if (!cfg || typeof cfg !== 'object') return false;

  const added = [];

  // appName (introduced as a template var in v0.3.5).
  if (!cfg.appName && DEFAULT_CONFIG.appName) {
    cfg.appName = DEFAULT_CONFIG.appName;
    added.push('appName');
  }

  // presence.byStatus (introduced in v0.3.6) — the headline upgrade.
  // We only seed it when entirely absent. If a user has already started
  // editing their own byStatus, we leave it alone.
  cfg.presence = cfg.presence || {};
  if (!cfg.presence.byStatus && DEFAULT_CONFIG.presence?.byStatus) {
    cfg.presence.byStatus = JSON.parse(JSON.stringify(DEFAULT_CONFIG.presence.byStatus));
    added.push('presence.byStatus');
  }

  // Refresh the lifetime tooltip when the user is on the very old default
  // ("…{daysSinceFirstLabel}") so they pick up the new streak-aware copy
  // without us touching anything they've customized.
  const OLD_LIT = '{modelPretty} · {allHours} on Claude · {daysSinceFirstLabel}';
  if (cfg.presence.largeImageText === OLD_LIT && DEFAULT_CONFIG.presence?.largeImageText) {
    cfg.presence.largeImageText = DEFAULT_CONFIG.presence.largeImageText;
    added.push('presence.largeImageText');
  }

  // v0.6.3: byStatus.working.state and .thinking.state used `{tokensFmt} tokens`
  // which renders "0 tokens" before any session activity has accrued — combined
  // with empty `{currentFilePretty}` for tools like Bash, that surfaced as
  // "Bash · · 0 tokens" on the card. New default uses `{tokensLabel}` which is
  // empty until tokens > 0, and fillTemplate now collapses adjacent separators.
  // Migrate only the verbatim old template — leave anything the user customized.
  const OLD_WORKING = '{currentToolPretty} · {currentFilePretty} · {tokensFmt} tokens';
  const OLD_THINKING = '{modelPretty} · {messagesLabel} · {tokensFmt} tokens';
  if (cfg.presence.byStatus?.working?.state === OLD_WORKING &&
      DEFAULT_CONFIG.presence?.byStatus?.working?.state) {
    cfg.presence.byStatus.working.state = DEFAULT_CONFIG.presence.byStatus.working.state;
    added.push('presence.byStatus.working.state');
  }
  if (cfg.presence.byStatus?.thinking?.state === OLD_THINKING &&
      DEFAULT_CONFIG.presence?.byStatus?.thinking?.state) {
    cfg.presence.byStatus.thinking.state = DEFAULT_CONFIG.presence.byStatus.thinking.state;
    added.push('presence.byStatus.thinking.state');
  }

  // v0.7: community.enabled flipped to true in DEFAULT_CONFIG. For users
  // upgrading from a version without a community block, we must NOT
  // silently turn telemetry on — write an explicit `enabled: false` so
  // the deep-merge in loadConfig sees their opt-out. They can run
  // `claude-rpc community on` to consent.
  if (!cfg.community) {
    cfg.community = { enabled: false };
    added.push('community (preserved-off)');
  }

  // Button defaults have moved twice: the Claude Code website (pre-v0.8.1) →
  // the project repo (v0.8.1) → a landing-page call-to-action (v0.13). Existing
  // configs carry their own `buttons` array, which fully REPLACES the default
  // (arrays don't deep-merge), so a new default never reaches upgraders just by
  // bumping the package. Upgrade any button that's still a verbatim shipped
  // default to the current CTA; as a safety net, also repoint a button that's
  // merely been relabeled but still aims at the long-dead claude.com URL.
  // Anything a user fully customized (their own label AND url) is left alone.
  const NEW_BTN = DEFAULT_CONFIG.presence?.buttons?.[0];
  const SHIPPED_DEFAULT_BTNS = [
    { label: 'Claude Code', url: 'https://claude.com/claude-code' },
    { label: 'Claude Code', url: 'https://github.com/rar-file/claude-rpc' },
  ];
  if (NEW_BTN && Array.isArray(cfg.presence?.buttons)) {
    let changed = false;
    for (const b of cfg.presence.buttons) {
      if (!b) continue;
      const isShippedDefault = SHIPPED_DEFAULT_BTNS.some((d) => d.label === b.label && d.url === b.url);
      const alreadyCurrent = b.label === NEW_BTN.label && b.url === NEW_BTN.url;
      if (isShippedDefault && !alreadyCurrent) {
        b.label = NEW_BTN.label; b.url = NEW_BTN.url; changed = true;
      } else if (b.url === 'https://claude.com/claude-code') {
        b.url = NEW_BTN.url; changed = true;   // dead link, keep their custom label
      }
    }
    if (changed) added.push('presence.buttons[] → CTA');
  }

  if (added.length === 0) return false;
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  if (!silent) dirtyStep(SYM_OK, 'config migrated', `added: ${added.join(', ')}`);
  return true;
}

// Round-trip a synthetic SessionStart event through the same launcher
// shape that Claude Code itself will use. Proves the hook command actually
// resolves and runs — without this, `setup` could happily wire a broken
// command and report success, leaving the user to discover the breakage
// the next time they open Claude Code. Returns { ok, detail }.
function verifyHookPipe(exePath) {
  const cmd  = IS_PACKAGED ? exePath
              : IS_NPM_INSTALL ? 'claude-rpc'
              : process.execPath;
  const args = IS_PACKAGED || IS_NPM_INSTALL
              ? ['hook', 'SessionStart']
              : [HOOK_SCRIPT, 'SessionStart'];
  // Windows + npm-install: the global bin is `claude-rpc.cmd` (a batch shim),
  // and Node's spawn doesn't apply PATHEXT — calling `claude-rpc` raw fails
  // with ENOENT. shell:true makes cmd.exe do the resolution, mirroring how
  // Claude Code actually invokes the hook string at runtime. Args are static
  // and trusted; no injection surface.
  const useShell = IS_NPM_INSTALL && process.platform === 'win32';
  let result;
  try {
    result = spawnSync(cmd, args, {
      input: '',
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
      shell: useShell,
    });
  } catch (e) {
    return { ok: false, detail: `spawn failed: ${e.message}` };
  }
  if (result.error) return { ok: false, detail: `spawn error: ${result.error.message}` };
  if (result.status !== 0) {
    return { ok: false, detail: `hook exit ${result.status}: ${(result.stderr || '').trim().slice(0, 120)}` };
  }
  if (!result.stdout.includes('"continue"')) {
    return { ok: false, detail: `unexpected hook output: ${result.stdout.trim().slice(0, 120)}` };
  }
  return { ok: true, detail: 'SessionStart round-trip succeeded' };
}

// `npx claude-rpc setup` runs from npm's throwaway _npx cache, so the
// `claude-rpc` bin the hooks resolve through PATH disappears the moment npx
// exits. Promote to a real global install first, then the rest of setup wires
// hooks to the now-persistent global bin exactly like a normal npm install.
// Best-effort + loud: a failed -g (perms, offline) returns false so the caller
// can stop with the manual command rather than wire a dead hook.
function promoteNpxToGlobal() {
  // Already promoted on a previous run? The PATH-resolved bin answers fast.
  try {
    const v = spawnSync('claude-rpc', ['--version'], {
      encoding: 'utf8', timeout: 4000, windowsHide: true,
      shell: process.platform === 'win32',
    });
    if ((v.stdout || '').trim() === `claude-rpc ${VERSION}`) {
      noop('global install current');
      return true;
    }
  } catch { /* not installed yet — promote below */ }
  const r = spawnSync('npm', ['install', '-g', `claude-rpc@${VERSION}`], {
    encoding: 'utf8',
    shell: process.platform === 'win32',   // npm is npm.cmd on Windows
  });
  if (r.error || r.status !== 0) {
    // The piped npm chatter only matters when it failed.
    if (r.stdout) process.stderr.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    return false;
  }
  dirtyStep(SYM_OK, 'installed globally', `claude-rpc@${VERSION} — hooks survive npx's throwaway cache`);
  return true;
}

// Best-effort registry check. npx serves stale cached copies without
// warning, and promoteNpxToGlobal pins @VERSION — so a stale npx cache
// would otherwise propagate itself into the global install silently, and
// the user's next `claude-rpc profile …` hits "unknown command" with no
// clue why. Warn loudly up front; never block setup on it (offline is fine).
function warnIfStale() {
  try {
    const r = spawnSync('npm', ['view', 'claude-rpc', 'version'], {
      encoding: 'utf8', timeout: 4000,
      shell: process.platform === 'win32',   // npm is npm.cmd on Windows
    });
    const latest = (r.stdout || '').trim();
    if (!latest || latest === VERSION) return;
    const num = (v) => v.split('.').map((n) => parseInt(n, 10) || 0);
    const [l, v] = [num(latest), num(VERSION)];
    const newer = l[0] !== v[0] ? l[0] > v[0] : l[1] !== v[1] ? l[1] > v[1] : l[2] > v[2];
    if (newer) {
      step(SYM_WARN, 'newer version', `v${latest} is published but this is v${VERSION} — npx may have served a stale cache`, console.warn);
      hintLine('for the newest version, stop here and re-run: npx claude-rpc@latest setup', process.stderr);
    }
  } catch { /* offline or npm missing — a version check must never block setup */ }
}

export async function install({ exePath, withStartup = true } = {}) {
  resetRun();
  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ claude-rpc setup${c.reset}  ${c.dim}v${VERSION}${c.reset}`);
  warnIfStale();
  if (IS_NPX) {
    if (!promoteNpxToGlobal()) {
      console.error('');
      step(SYM_FAIL, 'global install', 'failed', console.error);
      hintLine('run this once, then you\'re set: npm install -g claude-rpc && claude-rpc setup', process.stderr);
      const err = new Error('npx self-install failed');
      err.code = 3;   // system error (see exit-code contract)
      throw err;
    }
    step(SYM_OK, 'global install', `claude-rpc@${VERSION}`);
  }
  const incoming = exePath || process.execPath;
  // Canonicalize first so hook + startup entries point at a stable location,
  // not at the temp/Downloads path the user happened to launch from.
  if (IS_PACKAGED) phase('binary');
  const target = ensureCanonicalExe(incoming);

  phase('config');
  // Order matters: seed creates the file if missing, then migrate fills in
  // any blocks new exe versions added (e.g. presence.byStatus from v0.3.6).
  seedConfig();
  migrateConfig();

  phase('claude code');
  installHooks(target);
  // Proof the hook pipe actually fires. A setup that returns success
  // without verification is a lie — we caught broken-hook-path bugs
  // twice during v0.3.x because no one ran a real event after install.
  const probe = verifyHookPipe(target);
  if (!probe.ok) {
    step(SYM_FAIL, 'hook verify', probe.detail, console.warn);
    hintLine('run `claude-rpc doctor` for a full diagnostic', process.stderr);
  } else if (runDirty) {
    step(SYM_OK, 'hook verified', probe.detail);
  } else {
    noop('hook pipe verified');
  }

  // The CLI's setup case launches the daemon right after this returns, so its
  // row lands under this heading; setupOutro() then closes the screen.
  phase('daemon');
  if (withStartup) {
    if (process.platform === 'win32') {
      try { await addStartupEntry(target); }
      catch (e) { step(SYM_WARN, 'startup entry', `failed: ${e.message}`, console.warn); }
    } else if (runDirty) {
      step(SYM_INFO, 'startup entry', 'skipped — login autostart is Windows-only');
    }
  }
  // Nothing changed: the checklist above stayed silent, so say so in one line.
  if (!runDirty && probe.ok) {
    console.log(`  ${SYM_OK}  ${c.bold}already set up${c.reset}  ${c.dim}${noopFacts.join(' · ')}${c.reset}`);
  }
  return { target, changed: runDirty };
}

// The single closing block of `claude-rpc setup` — what to do now, where the
// levers are. Printed by the CLI after the daemon launch so it always lands
// last; doctor --fix re-runs install() without it.
export function setupOutro(target, changed = true) {
  if (!changed) return;
  const point = (label, value, note = '') =>
    console.log(`     ${c.dim}→${c.reset}  ${c.dim}${label.padEnd(14)}${c.reset} ${c.cyan}${value}${c.reset}${note ? `  ${c.dim}${note}${c.reset}` : ''}`);
  console.log('');
  console.log(`  ${SYM_OK}  ${c.bold}setup complete${c.reset} — open Claude Code and send a prompt; your card goes live in Discord.`);
  point('verify wiring', 'claude-rpc doctor');
  if (IS_PACKAGED) point('start daemon', `"${target}" daemon`, 'also runs automatically at login');
  else point('manage daemon', 'claude-rpc start · stop · status');
  point('config', CONFIG_PATH, 'a working Discord app is bundled — set clientId only to use your own');
  point('other machine?', 'claude-rpc link', 'run it there, claim the code here — one leaderboard profile');
  console.log('');
}

export async function uninstall() {
  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ claude-rpc uninstall${c.reset}`);
  console.log('');
  uninstallHooks();
  if (process.platform === 'win32') await removeStartupEntry();
  console.log('');
  console.log(`  ${SYM_OK}  ${c.bold}uninstalled${c.reset} — config at ${c.cyan}${USER_CONFIG_DIR}${c.reset} ${c.dim}left intact; delete it manually if you want.${c.reset}`);
  console.log('');
}

export function isInstalled() {
  return IS_PACKAGED && existsSync(CONFIG_PATH);
}
