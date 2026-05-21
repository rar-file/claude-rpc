import { homedir, tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Detect packaged mode. Covers both pkg (process.pkg) and Node SEA (where
// process.execPath is the renamed exe rather than node/node.exe).
export const IS_PACKAGED = typeof process.pkg !== 'undefined'
  || !/[\\/]node(\.exe)?$/i.test(process.execPath || '');

export const ROOT = resolve(__dirname, '..');

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
export const CONFIG_PATH = IS_PACKAGED
  ? join(USER_CONFIG_DIR, 'config.json')
  : join(ROOT, 'config.json');

// Template seeded into USER_CONFIG_DIR on first install.
export const BUNDLED_CONFIG_EXAMPLE = join(ROOT, 'config.example.json');

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
