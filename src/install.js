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
  HOOK_SCRIPT, IS_PACKAGED, IS_NPM_INSTALL,
  CANONICAL_EXE, CANONICAL_INSTALL_DIR, CANONICAL_EXE_NAME,
} from './paths.js';
import { DEFAULT_CONFIG } from './default-config.js';

const STARTUP_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const STARTUP_VALUE = 'ClaudeRPC';

const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Stop', 'SubagentStop', 'Notification', 'SessionEnd',
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
  writeJson(CLAUDE_SETTINGS, settings);
  console.log(`  hooks → ${CLAUDE_SETTINGS}`);
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
  console.log(`  hooks removed from ${CLAUDE_SETTINGS}`);
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

export async function addStartupEntry(exePath) {
  await regCommand([
    'add', STARTUP_KEY,
    '/v', STARTUP_VALUE,
    '/t', 'REG_SZ',
    '/d', `"${exePath}" daemon`,
    '/f',
  ]);
  console.log(`  startup → HKCU\\...\\Run\\${STARTUP_VALUE}`);
}

export async function removeStartupEntry() {
  try {
    await regCommand(['delete', STARTUP_KEY, '/v', STARTUP_VALUE, '/f']);
    console.log(`  startup entry removed`);
  } catch {
    // Already absent — fine.
  }
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
        console.log(`  exe already installed → ${CANONICAL_EXE}`);
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
    console.log(`  exe installed → ${CANONICAL_EXE}`);
    console.log(`  (the copy at ${currentExe} can be safely deleted)`);
    sweepStaleCanonicalBackups();
    return CANONICAL_EXE;
  } catch (e) {
    console.warn(`  ! failed to copy exe to ${CANONICAL_EXE}: ${e.message}`);
    console.warn(`    falling back to ${currentExe} — manual updates that change`);
    console.warn(`    the exe path may require running 'setup' again.`);
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
        console.log(`  config migrated → ${CONFIG_PATH}`);
        console.log(`    (was: ${legacyPath} — safe to delete on next 'npm update')`);
        return false;
      }
    } catch (e) {
      console.warn(`  ! legacy-config migration skipped: ${e.message}`);
    }
  }

  if (existsSync(CONFIG_PATH)) {
    console.log(`  config exists → ${CONFIG_PATH}`);
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
  console.log(`  config seeded → ${CONFIG_PATH}`);
  if (seeded.community?.enabled && seeded.community.instanceId) {
    console.log(`  community totals on by default → opt out with \`claude-rpc community off\``);
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
    if (!silent) console.warn(`  ! could not read config for migration: ${e.message}`);
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

  // v0.8.1: the default presence button moved from the Claude Code website
  // to the project repo. Existing configs carry their own `buttons` array,
  // which fully REPLACES the default (arrays don't deep-merge) — so the new
  // default never reaches upgraders just by bumping the package. Rewrite
  // ONLY a button still pointing at the verbatim old default URL; anything a
  // user has customized (label or url) is left untouched.
  const OLD_BTN_URL = 'https://claude.com/claude-code';
  const NEW_BTN_URL = DEFAULT_CONFIG.presence?.buttons?.[0]?.url;
  if (NEW_BTN_URL && Array.isArray(cfg.presence?.buttons)) {
    let changed = false;
    for (const b of cfg.presence.buttons) {
      if (b && b.url === OLD_BTN_URL) { b.url = NEW_BTN_URL; changed = true; }
    }
    if (changed) added.push('presence.buttons[].url → repo');
  }

  if (added.length === 0) {
    if (!silent) console.log(`  config up to date → ${CONFIG_PATH}`);
    return false;
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  if (!silent) {
    console.log(`  config migrated  → ${CONFIG_PATH}`);
    console.log(`    added: ${added.join(', ')}`);
  }
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

export async function install({ exePath, withStartup = true } = {}) {
  if (process.platform !== 'win32' && withStartup) {
    console.warn('Note: startup registration only works on Windows; other steps still run.');
  }
  const incoming = exePath || process.execPath;
  // Canonicalize first so hook + startup entries point at a stable location,
  // not at the temp/Downloads path the user happened to launch from.
  const target = ensureCanonicalExe(incoming);
  console.log('Installing Claude RPC…');
  // Order matters: seed creates the file if missing, then migrate fills in
  // any blocks new exe versions added (e.g. presence.byStatus from v0.3.6).
  seedConfig();
  migrateConfig();
  installHooks(target);
  if (withStartup && process.platform === 'win32') {
    try { await addStartupEntry(target); }
    catch (e) { console.warn(`  startup entry failed: ${e.message}`); }
  }

  // Proof the hook pipe actually fires. A setup that returns success
  // without verification is a lie — we caught broken-hook-path bugs
  // twice during v0.3.x because no one ran a real event after install.
  const probe = verifyHookPipe(target);
  if (probe.ok) {
    console.log(`  hook pipe   ✓ ${probe.detail}`);
  } else {
    console.warn(`  hook pipe   ✗ ${probe.detail}`);
    console.warn(`              ↳ run \`claude-rpc doctor\` for a full diagnostic`);
  }

  console.log('\nDone.');
  console.log(`Edit ${CONFIG_PATH} to set your Discord clientId, then run:`);
  // Per-mode "start" instructions — packaged exe takes a daemon subcommand,
  // the npm bin shim handles `start` as a subcommand of itself, and dev
  // mode runs the daemon script directly through node.
  if (IS_PACKAGED) {
    console.log(`  "${target}" daemon`);
  } else if (IS_NPM_INSTALL) {
    console.log(`  claude-rpc start`);
  } else {
    console.log(`  node "${join(ROOT, 'src', 'daemon.js').replace(/\\/g, '/')}"`);
    console.log(`  # or: claude-rpc start  (if you've run \`npm link\`)`);
  }
  console.log(`\nThen: \`claude-rpc doctor\` to verify everything is wired.`);
}

export async function uninstall() {
  console.log('Uninstalling Claude RPC…');
  uninstallHooks();
  if (process.platform === 'win32') await removeStartupEntry();
  console.log('\nDone. (Config at %APPDATA%\\claude-rpc\\ left intact — delete manually if you want.)');
}

export function isInstalled() {
  return IS_PACKAGED && existsSync(CONFIG_PATH);
}
