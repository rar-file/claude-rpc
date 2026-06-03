import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Detect packaged mode. Covers both pkg (process.pkg) and Node SEA (where
// process.execPath is the renamed exe rather than node/node.exe).
export const IS_PACKAGED = typeof process.pkg !== 'undefined'
  || !/[\\/]node(\.exe)?$/i.test(process.execPath || '');

export const ROOT = resolve(__dirname, '..');

// True when we're running from a node_modules tree — `npm install -g claude-rpc`
// or a local project's `node_modules`. Distinct from packaged mode (single
// SEA exe) and dev mode (cloned repo, no node_modules wrapper).
export const IS_NPM_INSTALL = !IS_PACKAGED && /[\\/]node_modules[\\/]/i.test(ROOT);

// True when we were launched via `npx claude-rpc` — npm stages the package in
// its ephemeral `_npx/<hash>/node_modules/...` cache, which matches the
// node_modules test above but is DELETED when the process exits. A hook wired
// to the PATH-resolved `claude-rpc` bin would dangle, so setup must promote an
// npx run to a real global install before wiring anything. See install.js.
export const IS_NPX = IS_NPM_INSTALL && /[\\/]_npx[\\/]/i.test(ROOT);

// "Installed" covers both real distribution paths — config and runtime
// artifacts live outside the install tree so they survive package updates.
export const IS_INSTALLED = IS_PACKAGED || IS_NPM_INSTALL;

// In packaged mode, persist user config in the per-OS app-data directory.
// In dev mode, keep config.json next to the source tree for easy iteration.
//   Windows: %APPDATA%\claude-rpc\
//   macOS:   ~/Library/Application Support/claude-rpc/
//   Linux:   $XDG_CONFIG_HOME/claude-rpc/  (default ~/.config/claude-rpc/)
function userConfigDir() {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appdata, 'claude-rpc');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'claude-rpc');
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, 'claude-rpc');
}
export const USER_CONFIG_DIR = userConfigDir();
// Persist config under USER_CONFIG_DIR whenever we're "installed" — packaged
// exe OR npm-installed. The dev path keeps config next to source for easy
// iteration. Putting it in node_modules would mean every `npm update` blows
// away the user's clientId.
export const CONFIG_PATH = IS_INSTALLED
  ? join(USER_CONFIG_DIR, 'config.json')
  : join(ROOT, 'config.json');

// Canonical home for the packaged exe. `setup` copies the running binary here
// (from wherever the user launched it — Downloads, Desktop, etc.) so the path
// baked into Claude Code's hooks survives manual updates that drop the new exe
// at a different filesystem location.
export const CANONICAL_EXE_NAME = process.platform === 'win32' ? 'claude-rpc.exe' : 'claude-rpc';
export const CANONICAL_INSTALL_DIR = join(USER_CONFIG_DIR, 'bin');
export const CANONICAL_EXE = join(CANONICAL_INSTALL_DIR, CANONICAL_EXE_NAME);

// In packaged mode the "scripts" are sub-commands of the exe itself; in dev
// they're the source .js files.
export const HOOK_SCRIPT = IS_PACKAGED ? process.execPath : join(ROOT, 'src', 'hook.js');
export const DAEMON_SCRIPT = IS_PACKAGED ? process.execPath : join(ROOT, 'src', 'daemon.js');
export const EXE_PATH = IS_PACKAGED ? process.execPath : null;

export const STATE_DIR = join(tmpdir(), 'claude-rpc');
export const STATE_PATH = join(STATE_DIR, 'state.json');
export const PID_PATH = join(STATE_DIR, 'daemon.pid');
export const LOG_PATH = join(STATE_DIR, 'daemon.log');
export const DATA_DIR = join(homedir(), '.claude-rpc');
export const AGGREGATE_PATH = join(DATA_DIR, 'aggregate.json');
export const SCAN_CACHE_PATH = join(DATA_DIR, 'scan-cache.json');
export const EVENTS_LOG_PATH = join(DATA_DIR, 'events.jsonl');
export const CLAUDE_HOME = join(homedir(), '.claude');
export const CLAUDE_PROJECTS = join(CLAUDE_HOME, 'projects');
export const CLAUDE_SETTINGS = join(CLAUDE_HOME, 'settings.json');
