// One-shot installer logic invoked by the bundled exe.
// Seeds %APPDATA%\claude-rpc\config.json, points Claude Code's hooks at the
// exe, and registers a Windows startup entry so the daemon comes up on login.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  copyFileSync, chmodSync, renameSync, statSync,
  readdirSync, unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  CLAUDE_SETTINGS, CONFIG_PATH, USER_CONFIG_DIR,
  HOOK_SCRIPT, IS_PACKAGED,
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
  // Packaged: `"<exe>" hook <event>`. Dev: `node "<src/hook.js>" <event>`.
  const cmdFor = IS_PACKAGED
    ? (event) => `"${exePath}" hook ${event}`
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
        try { unlinkSync(join(CANONICAL_INSTALL_DIR, name)); } catch {}
      }
    }
  } catch {}
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
    } catch {}
  }

  try {
    // Windows won't let you overwrite a currently-executing file. If
    // canonical is the running daemon, move it aside first — that succeeds
    // even while the file handle is open, and Windows will delete the
    // renamed copy when the process exits.
    if (process.platform === 'win32' && existsSync(CANONICAL_EXE)) {
      try { renameSync(CANONICAL_EXE, CANONICAL_EXE + '.old-' + Date.now()); }
      catch {}
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
  if (existsSync(CONFIG_PATH)) {
    console.log(`  config exists → ${CONFIG_PATH}`);
    return false;
  }
  mkdirSync(USER_CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  console.log(`  config seeded → ${CONFIG_PATH}`);
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
export function migrateConfig() {
  if (!existsSync(CONFIG_PATH)) return false;
  let cfg;
  try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) {
    console.warn(`  ! could not read config for migration: ${e.message}`);
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

  if (added.length === 0) {
    console.log(`  config up to date → ${CONFIG_PATH}`);
    return false;
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  console.log(`  config migrated  → ${CONFIG_PATH}`);
  console.log(`    added: ${added.join(', ')}`);
  return true;
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
  console.log('\nDone.');
  console.log(`Edit ${CONFIG_PATH} to set your Discord clientId, then either reboot or run:`);
  console.log(`  "${target}" daemon`);
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
