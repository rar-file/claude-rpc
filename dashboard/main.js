const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const os = require('node:os');

let configPath = null;
let repoRoot = null;
let mainWindow = null;
let serveChild = null;

function findConfigPath() {
  const exeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(process.cwd(), 'config.json'),
    path.join(exeDir, 'config.json'),
    path.join(exeDir, '..', 'config.json'),
    path.resolve(__dirname, '..', 'config.json'),
    path.resolve(__dirname, '..', '..', 'config.json'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

function findRepoRoot(cfgPath) {
  if (!cfgPath) return null;
  let dir = path.dirname(cfgPath);
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'src', 'cli.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function pickConfigPath() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate claude-rpc config.json',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 860,
    backgroundColor: '#0a0a0a',
    title: 'Claude RPC',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  configPath = findConfigPath();
  repoRoot = findRepoRoot(configPath);
  createWindow();
});

// ── Config ───────────────────────────────────────────────────────────────────
ipcMain.handle('load-config', async () => {
  if (!configPath) configPath = await pickConfigPath();
  if (!configPath) return { error: 'No config path selected' };
  repoRoot = findRepoRoot(configPath);
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { configPath, config };
  } catch (e) {
    return { error: `Failed to read ${configPath}: ${e.message}` };
  }
});

ipcMain.handle('pick-config', async () => {
  const picked = await pickConfigPath();
  if (picked) { configPath = picked; repoRoot = findRepoRoot(picked); }
  return { configPath };
});

ipcMain.handle('save-config', async (_, newConfig) => {
  if (!configPath) return { error: 'No config path' };
  try {
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

// ── Daemon control ───────────────────────────────────────────────────────────
function daemonPidPath() { return path.join(os.tmpdir(), 'claude-rpc', 'daemon.pid'); }
function daemonLogPath() { return path.join(os.tmpdir(), 'claude-rpc', 'daemon.log'); }

ipcMain.handle('daemon-status', async () => {
  const pidPath = daemonPidPath();
  try {
    if (!fs.existsSync(pidPath)) return { running: false };
    const pid = Number(fs.readFileSync(pidPath, 'utf8'));
    if (!pid) return { running: false };
    process.kill(pid, 0);
    return { running: true, pid };
  } catch { return { running: false }; }
});

function runCli(args, opts = {}) {
  if (!repoRoot) return Promise.resolve({ ok: false, output: 'Repo root not found' });
  const cli = path.join(repoRoot, 'src', 'cli.js');
  if (!fs.existsSync(cli)) return Promise.resolve({ ok: false, output: `cli.js not found at ${cli}` });
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'node.exe' : 'node', [cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: repoRoot,
      windowsHide: true,
      detached: opts.detached || false,
    });
    if (opts.detached) child.unref();
    let out = '';
    child.stdout?.on('data', (d) => out += d.toString());
    child.stderr?.on('data', (d) => out += d.toString());
    child.on('error', (e) => resolve({ ok: false, output: e.message }));
    if (opts.detached) {
      resolve({ ok: true, output: 'started' });
    } else {
      child.on('close', (code) => resolve({ ok: code === 0, output: out }));
    }
  });
}

ipcMain.handle('daemon-start',   async () => runCli(['start'], { detached: false }));
ipcMain.handle('daemon-stop',    async () => runCli(['stop']));
ipcMain.handle('daemon-restart', async () => runCli(['restart']));

// ── Log tail ─────────────────────────────────────────────────────────────────
ipcMain.handle('tail-log', async () => {
  const p = daemonLogPath();
  try {
    if (!fs.existsSync(p)) return { path: p, content: '' };
    const raw = fs.readFileSync(p, 'utf8');
    // Tail the last ~80 lines.
    const lines = raw.split('\n');
    const tail = lines.slice(-80).join('\n');
    return { path: p, content: tail };
  } catch (e) {
    return { path: p, content: `error: ${e.message}` };
  }
});

// ── Variables (for autocomplete) ─────────────────────────────────────────────
// Spawn a tiny one-shot via node that imports format.js, builds vars from
// real state + aggregate, and prints JSON. Falls back to a static key list
// when the helper isn't available.
ipcMain.handle('list-vars', async () => {
  if (!repoRoot) return { vars: [], live: null };
  try {
    const helper = `
      import { readState } from './src/state.js';
      import { readAggregate, findLiveSessions } from './src/scanner.js';
      import { buildVars, applyIdle } from './src/format.js';
      const { readFileSync, existsSync } = await import('node:fs');
      const { CONFIG_PATH } = await import('./src/paths.js');
      let state = readState();
      state.liveSessions = findLiveSessions({ thresholdMs: 90_000 });
      let cfg = {};
      try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
      state = applyIdle(state, cfg);
      const agg = readAggregate() || {};
      const v = buildVars(state, cfg, agg);
      process.stdout.write(JSON.stringify({ vars: Object.keys(v).sort(), live: v }));
    `;
    const result = spawnSync(process.platform === 'win32' ? 'node.exe' : 'node',
      ['--input-type=module', '-e', helper],
      { cwd: repoRoot, encoding: 'utf8', timeout: 4000 });
    if (result.status !== 0) return { vars: [], live: null };
    return JSON.parse(result.stdout.trim());
  } catch {
    return { vars: [], live: null };
  }
});

// ── Local server ─────────────────────────────────────────────────────────────
ipcMain.handle('start-serve', async () => {
  if (!repoRoot) return { ok: false };
  if (serveChild) return { ok: true };
  const cli = path.join(repoRoot, 'src', 'cli.js');
  serveChild = spawn(process.platform === 'win32' ? 'node.exe' : 'node', [cli, 'serve'], {
    cwd: repoRoot,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
    env: { ...process.env, CLAUDE_RPC_NO_OPEN: '1' },
  });
  serveChild.unref();
  return { ok: true };
});

ipcMain.handle('open-external', async (_, url) => {
  if (!url) return { ok: false };
  shell.openExternal(url);
  return { ok: true };
});

app.on('window-all-closed', () => {
  try { if (serveChild) process.kill(-serveChild.pid); } catch {}
  app.quit();
});
