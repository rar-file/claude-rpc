const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const resolveRpcPort = require('./port.js');
const { mergeConfig, applyEdits } = require('./config-edit.js');

// Lazy-require electron-updater so dev mode (where the dep may not be
// installed yet) doesn't crash on import. It's only meaningful in a
// packaged app anyway.
function loadAutoUpdater() {
  try { return require('electron-updater').autoUpdater; }
  catch { return null; }
}

let configPath = null;
let cliResolution = null;   // { kind: 'binary'|'node', path, args? }
let mainWindow = null;
let serveChild = null;
let tray = null;
// Distinguishes a real quit (tray → Quit, or before-quit) from a window
// close, which we intercept to hide-to-tray instead of exiting.
app.isQuitting = false;

// One app per user. A second launch would otherwise add a second tray icon,
// re-run first-run setup and spawn a second `serve`. Instead it quits, and the
// running instance brings its window forward.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
app.on('second-instance', () => { if (app.isReady()) showWindow(); });

// ── CLI resolver ─────────────────────────────────────────────────────────────
// Three runtime modes the dashboard can land in:
//
//   1. Packaged Electron app   → bundled SEA binary at process.resourcesPath/bin/
//   2. Dev with a pre-built exe → repo's dist/claude-rpc[.exe]
//   3. Pure dev mode           → fall back to `node src/cli.js` against the
//      repo source tree
//
// First match wins.
function resolveCli() {
  if (cliResolution) return cliResolution;
  const isWin = process.platform === 'win32';
  const binName = isWin ? 'claude-rpc.exe' : 'claude-rpc';

  // (1) Packaged app — Electron exposes process.resourcesPath even outside
  //     packaging, so checking the file existence is what actually matters.
  const bundled = path.join(process.resourcesPath || '', 'bin', binName);
  if (fs.existsSync(bundled)) {
    cliResolution = { kind: 'binary', path: bundled };
    return cliResolution;
  }

  // (2) Dev tree with `npm run build:exe` already produced a binary.
  for (const root of devRepoCandidates()) {
    const candidate = path.join(root, 'dist', binName);
    if (fs.existsSync(candidate)) {
      cliResolution = { kind: 'binary', path: candidate };
      return cliResolution;
    }
  }

  // (3) Pure dev — spawn node on the source cli.
  for (const root of devRepoCandidates()) {
    const cli = path.join(root, 'src', 'cli.js');
    if (fs.existsSync(cli)) {
      cliResolution = {
        kind: 'node',
        path: isWin ? 'node.exe' : 'node',
        args: [cli],
        cwd: root,
      };
      return cliResolution;
    }
  }

  cliResolution = { kind: 'missing' };
  return cliResolution;
}

function devRepoCandidates() {
  // Walk up from __dirname (dashboard/) and process.cwd() looking for a
  // src/cli.js sibling. Covers both `electron .` from dashboard/ and from
  // the repo root.
  const roots = new Set();
  for (const start of [__dirname, process.cwd()]) {
    let dir = start;
    for (let i = 0; i < 4; i++) {
      roots.add(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return Array.from(roots);
}

// Per-OS default config path — matches src/paths.js logic so the dashboard
// edits the same file the CLI reads in packaged mode.
function defaultUserConfigPath() {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, 'claude-rpc', 'config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'claude-rpc', 'config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'claude-rpc', 'config.json');
}

function findConfigPath() {
  const exeDir = path.dirname(process.execPath);
  const userConfig = defaultUserConfigPath();
  // In packaged mode the user-config dir is what the CLI reads; probe it first
  // so a stray cwd/config.json can't shadow it and make saves appear to do
  // nothing. In dev mode the original order is preserved so `electron .` from
  // the repo root still picks up the local config.json for iteration.
  const candidates = app.isPackaged
    ? [
        userConfig,
        path.join(exeDir, 'config.json'),
        path.join(exeDir, '..', 'config.json'),
      ]
    : [
        path.join(process.cwd(), 'config.json'),
        path.join(exeDir, 'config.json'),
        path.join(exeDir, '..', 'config.json'),
        path.resolve(__dirname, '..', 'config.json'),
        path.resolve(__dirname, '..', '..', 'config.json'),
        userConfig,
      ];
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; } catch {}
  }
  return null;
}

// First-launch seeding: if no config exists anywhere, copy the bundled
// config.example.json (shipped alongside the CLI binary or in the repo) to
// the per-OS user config dir.
function seedUserConfigIfMissing() {
  const target = defaultUserConfigPath();
  if (fs.existsSync(target)) return target;

  const sources = [];
  if (process.resourcesPath) sources.push(path.join(process.resourcesPath, 'config.example.json'));
  for (const root of devRepoCandidates()) sources.push(path.join(root, 'config.example.json'));

  for (const src of sources) {
    if (fs.existsSync(src)) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target);
        return target;
      } catch {}
    }
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
    backgroundColor: '#f4ede0', // styles.css --paper, so the window doesn't flash dark before the page paints
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
  // target=_blank links (the Discord tab's Developer Portal link, links inside
  // the Stats iframe) go to the OS browser, through the same http(s) check as
  // the 'open-external' IPC.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  // Close-to-tray: a window close hides instead of quitting, so the daemon
  // control stays a click away in the tray. A real quit goes through the
  // tray's Quit item (or before-quit), which sets app.isQuitting first.
  mainWindow.on('close', (e) => {
    if (app.isQuitting || !tray) return;
    e.preventDefault();
    mainWindow.hide();
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Only ever hand web URLs to the OS. A compromised renderer, or a page loaded
// in the Stats iframe, must not be able to launch file:// or app-protocol
// handlers. Returns whether the URL was opened.
function openExternalSafe(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  shell.openExternal(parsed.href);
  return true;
}

// Tray icon + right-click menu. The daemon actions reuse the same runCli
// path the in-window Daemon tab uses; rebuilding the menu after each one
// keeps the running/stopped label honest.
async function rebuildTrayMenu() {
  if (!tray) return;
  let running = false;
  try {
    const pidPath = daemonPidPath();
    if (fs.existsSync(pidPath)) {
      const pid = Number(fs.readFileSync(pidPath, 'utf8'));
      if (pid) { process.kill(pid, 0); running = true; }
    }
  } catch { running = false; }

  const menu = Menu.buildFromTemplate([
    { label: running ? '● Daemon running' : '○ Daemon stopped', enabled: false },
    { type: 'separator' },
    { label: 'Open settings', click: () => showWindow() },
    { label: 'Open web dashboard', click: async () => {
      // Same server the Stats tab uses. It starts with CLAUDE_RPC_NO_OPEN, so
      // this is the only place that opens a browser tab.
      await ensureServe();
      openExternalSafe(`http://127.0.0.1:${resolveRpcPort()}`);
    } },
    { type: 'separator' },
    { label: 'Start daemon',   enabled: !running, click: async () => { await runCli(['start'], { detached: true }); setTimeout(rebuildTrayMenu, 800); } },
    { label: 'Stop daemon',    enabled: running,  click: async () => { await runCli(['stop']);    rebuildTrayMenu(); } },
    { label: 'Restart daemon', enabled: running,  click: async () => { await runCli(['restart']); setTimeout(rebuildTrayMenu, 800); } },
    { label: 'Run setup (wire hooks)', click: async () => {
      const r = await runCli(['setup']);
      if (r.ok) markSetupDone(await cliVersion());
      sendToRenderer('setup-result', { ok: r.ok, auto: false, output: String(r.output || '').slice(-4000) });
      setTimeout(rebuildTrayMenu, 800);
    } },
    { type: 'separator' },
    { label: 'Quit Claude RPC', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  if (icon.isEmpty()) return; // no icon → skip tray rather than show a blank one
  tray = new Tray(icon);
  tray.setToolTip('Claude RPC');
  // Windows/Linux: a left-click on the tray icon shows the window.
  tray.on('click', () => showWindow());
  rebuildTrayMenu();
}

app.whenReady().then(() => {
  if (!isPrimaryInstance) return; // quitting; the first instance has been focused
  configPath = findConfigPath() || seedUserConfigIfMissing();
  createWindow();
  createTray();
  // macOS: clicking the Dock icon after the window was closed to the tray
  // brings it back (and re-creates it if it was destroyed).
  app.on('activate', () => showWindow());
  initAutoUpdater();
  // First-run setup — THE reason the installer exists. Until this ran, the
  // wizard-installed app was just a settings GUI: hooks never got wired, the
  // daemon never started, no card ever appeared, and the app looked broken.
  // Deferred a beat so the window paints first.
  setTimeout(() => ensureFirstRunSetup().catch((e) => console.error('[setup] auto-run failed:', e?.message || e)), 600);
});

// ── First-run setup ──────────────────────────────────────────────────────────
// Runs the bundled CLI's `setup` (idempotent: wires hooks into Claude Code,
// installs the canonical exe, seeds config, registers login autostart, starts
// the daemon, test-fires a hook) the first time the packaged app launches —
// and again whenever the bundled CLI version changes, so updates re-wire
// stale hook paths. A marker in userData keeps steady-state launches free of
// the multi-second setup run.
const setupMarkerPath = () => path.join(app.getPath('userData'), 'setup-done.json');

async function cliVersion() {
  const r = await runCli(['--version']);
  return r.ok ? String(r.output || '').trim() : null;
}

function markSetupDone(version) {
  try { fs.writeFileSync(setupMarkerPath(), JSON.stringify({ version, at: Date.now() })); }
  catch { /* marker is an optimization — setup itself stays idempotent */ }
}

async function ensureFirstRunSetup() {
  if (!app.isPackaged) return; // dev trees wire hooks via `node src/cli.js setup`
  const version = await cliVersion();
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(setupMarkerPath(), 'utf8')); } catch { /* first run */ }
  if (marker && version && marker.version === version) return;
  console.log(`[setup] auto-running (${marker ? `update ${marker.version} → ${version}` : 'first launch'})`);
  const result = await runCli(['setup']);
  if (result.ok && version) markSetupDone(version);
  sendToRenderer('setup-result', {
    ok: result.ok,
    auto: true,
    output: String(result.output || '').slice(-4000),
  });
  rebuildTrayMenu();
}

// ── Auto-update ──────────────────────────────────────────────────────────────
// Strategy: check once on startup (after a short delay so the window is up),
// then every hour. electron-updater downloads in the background and installs
// on next quit. Skipped in dev (not packaged) and in portable mode (where
// there's no installer to re-run — electron-updater handles this internally
// but we guard explicitly to avoid noisy logs).
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
let updateCheckTimer = null;
let updateDownloaded = false;

function initAutoUpdater() {
  if (!app.isPackaged) {
    console.log('[updater] skipped — not packaged');
    return;
  }
  // PORTABLE_EXECUTABLE_DIR is set by electron-builder's portable wrapper.
  // Auto-update can't replace a portable .exe in place; let it no-op.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    console.log('[updater] skipped — portable build');
    return;
  }
  const autoUpdater = loadAutoUpdater();
  if (!autoUpdater) {
    console.log('[updater] electron-updater not available');
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };

  // The update UI is this process's own dialog below; the renderer has none.
  autoUpdater.on('checking-for-update', () => console.log('[updater] checking'));
  autoUpdater.on('update-available', (info) => console.log('[updater] update available:', info.version));
  autoUpdater.on('update-not-available', () => console.log('[updater] up to date'));
  autoUpdater.on('error', (e) => console.error('[updater] error:', e?.message || e));
  autoUpdater.on('update-downloaded', async (info) => {
    if (updateDownloaded) return;  // guard against duplicate fires
    updateDownloaded = true;
    console.log('[updater] downloaded:', info.version);
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Claude RPC ${info.version} is ready to install.`,
      detail: 'The app will restart and apply the update.',
    });
    if (choice.response === 0) {
      autoUpdater.quitAndInstall();
    }
    // Otherwise installs automatically on next app quit.
  });

  // Initial check shortly after launch so we don't fight window paint.
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10_000);
  updateCheckTimer = setInterval(
    () => autoUpdater.checkForUpdates().catch(() => {}),
    UPDATE_CHECK_INTERVAL_MS,
  );
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ── Config ───────────────────────────────────────────────────────────────────
// DEFAULT_CONFIG lives in src/default-config.js (ESM, plain data). The packaged
// app ships a copy as resources/default-config.mjs (see extraResources in
// package.json), built from the same tree as the bundled CLI. Dev trees import
// it from the repo. If neither loads, the GUI shows the raw file and saving
// still writes only what was edited.
let defaultConfig; // undefined until the first load attempt; null if none loaded
async function loadDefaultConfig() {
  if (defaultConfig !== undefined) return defaultConfig;
  defaultConfig = null;
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'default-config.mjs'));
  for (const root of devRepoCandidates()) candidates.push(path.join(root, 'src', 'default-config.js'));
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      if (mod && mod.DEFAULT_CONFIG) { defaultConfig = mod.DEFAULT_CONFIG; break; }
    } catch { /* try the next candidate */ }
  }
  return defaultConfig;
}

ipcMain.handle('load-config', async () => {
  if (!configPath) configPath = await pickConfigPath();
  if (!configPath) return { error: 'No config path selected' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return { error: `Failed to read ${configPath}: ${e.message}` };
  }
  // Show the effective settings (defaults + the user's overrides), the way the
  // daemon sees them. A fresh two-line config would otherwise show no buttons.
  const defaults = await loadDefaultConfig();
  return { configPath, config: defaults ? mergeConfig(defaults, raw) : raw };
});

// payload: { base, edited }. base is the settings as the GUI showed them before
// any edits, and edited is the same settings after them. Only what differs
// between the two is written, onto the file as it is on disk NOW. Untouched
// keys stay as they are in the file, defaults are never frozen in, and keys the
// CLI wrote while the window was open survive. See config-edit.js.
ipcMain.handle('save-config', async (_, payload) => {
  if (!configPath) return { error: 'No config path' };
  const { base, edited } = payload || {};
  if (!edited || typeof edited !== 'object') return { error: 'Nothing to save' };
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    // A missing file is fine (the edits become its content). An unreadable or
    // half-written one is not: overwriting it would lose what's in it.
    if (e.code !== 'ENOENT') return { error: `Not saved: couldn't read ${configPath} (${e.message})` };
  }
  try {
    fs.writeFileSync(configPath, JSON.stringify(applyEdits(raw, base, edited), null, 2));
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

// Spawn the resolved CLI with the given subcommand args. Returns combined
// stdout/stderr for short-lived commands. A detached spawn just acks, and its
// output is discarded (stdio 'ignore'), so nothing buffers it for as long as
// the child lives.
function runCli(args, opts = {}) {
  const cli = resolveCli();
  if (cli.kind === 'missing') {
    return Promise.resolve({ ok: false, output: 'CLI binary not found (run `npm run build:exe` for dev, or reinstall the app).' });
  }

  const cmd = cli.path;
  const fullArgs = (cli.args || []).concat(args);

  return new Promise((resolve) => {
    const child = spawn(cmd, fullArgs, {
      stdio: opts.detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      cwd: cli.cwd || process.cwd(),
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

// Keep the tray's running/stopped label in sync when the user drives the
// daemon from the in-window Daemon tab, not just from the tray menu.
ipcMain.handle('run-setup', async () => {
  const r = await runCli(['setup']);
  if (r.ok) markSetupDone(await cliVersion());
  rebuildTrayMenu();
  return r;
});
ipcMain.handle('daemon-start',   async () => { const r = await runCli(['start']);   rebuildTrayMenu(); return r; });
ipcMain.handle('daemon-stop',    async () => { const r = await runCli(['stop']);    rebuildTrayMenu(); return r; });
ipcMain.handle('daemon-restart', async () => { const r = await runCli(['restart']); rebuildTrayMenu(); return r; });

// ── Data export ──────────────────────────────────────────────────────────────
// Reads the lifetime aggregate the daemon/scanner maintain at
// ~/.claude-rpc/aggregate.json and saves it (raw JSON, or byDay flattened to
// CSV) wherever the user picks. The CSV columns mirror src/server/api.js's
// aggregateToCsv — kept in sync by hand since the Electron main is CommonJS
// and can't import the ESM server module.
function aggregatePath() { return path.join(os.homedir(), '.claude-rpc', 'aggregate.json'); }

function aggToCsv(agg) {
  const cols = ['date', 'activeMs', 'activeHours', 'sessions', 'userMessages', 'toolCalls',
    'linesAdded', 'linesRemoved', 'cost', 'inputTokens', 'outputTokens',
    'cacheReadTokens', 'cacheWriteTokens', 'notifications'];
  const byDay = (agg && agg.byDay) || {};
  const rows = [cols.join(',')];
  for (const date of Object.keys(byDay).sort()) {
    const d = byDay[date] || {};
    const activeMs = d.activeMs || 0;
    rows.push([
      date, activeMs, (activeMs / 3_600_000).toFixed(3), d.sessions || 0,
      d.userMessages || 0, d.toolCalls || 0, d.linesAdded || 0, d.linesRemoved || 0,
      (d.cost || 0).toFixed(4), d.inputTokens || 0, d.outputTokens || 0,
      d.cacheReadTokens || 0, d.cacheWriteTokens || 0, d.notifications || 0,
    ].join(','));
  }
  return rows.join('\n') + '\n';
}

ipcMain.handle('export-data', async (_, format) => {
  const aggPath = aggregatePath();
  if (!fs.existsSync(aggPath)) {
    return { error: 'No aggregate data yet — start the daemon or run a scan first.' };
  }
  let agg;
  try { agg = JSON.parse(fs.readFileSync(aggPath, 'utf8')); }
  catch (e) { return { error: `Couldn't read aggregate: ${e.message}` }; }

  const isCsv = format === 'csv';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export claude-rpc data',
    defaultPath: isCsv ? 'claude-rpc-daily.csv' : 'claude-rpc-aggregate.json',
    filters: [isCsv ? { name: 'CSV', extensions: ['csv'] } : { name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    fs.writeFileSync(result.filePath, isCsv ? aggToCsv(agg) : JSON.stringify(agg, null, 2));
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { error: e.message };
  }
});

// ── Privacy / workspaces ─────────────────────────────────────────────────────
// The aggregate keys projects by display name, not path, so to manage privacy
// per-project we recover real cwds from transcript heads under
// ~/.claude/projects, then read/write the central visibility map at
// ~/.claude-rpc/private-list.json. That map is the same one src/privacy.js
// resolves against (keys are path.resolve'd cwds), so a toggle here takes
// effect on the Discord card without writing into any project directory.
function claudeProjectsDir() { return path.join(os.homedir(), '.claude', 'projects'); }
function privateListPath() { return path.join(os.homedir(), '.claude-rpc', 'private-list.json'); }
const VIS_LEVELS = ['public', 'name-only', 'hidden'];

function readCwdFromTranscript(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o && o.cwd) return o.cwd; } catch { /* partial/ non-JSON line */ }
    }
  } catch { /* unreadable transcript */ }
  return null;
}

function discoverWorkspaces() {
  const root = claudeProjectsDir();
  const seen = new Map(); // resolved cwd → { name, cwd, lastMs }
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); }
  catch { return []; }
  for (const d of dirs) {
    const pdir = path.join(root, d.name);
    let newest = null, newestMs = 0;
    try {
      for (const f of fs.readdirSync(pdir)) {
        if (!f.endsWith('.jsonl')) continue;
        const st = fs.statSync(path.join(pdir, f));
        if (st.mtimeMs > newestMs) { newestMs = st.mtimeMs; newest = path.join(pdir, f); }
      }
    } catch { continue; }
    if (!newest) continue;
    const raw = readCwdFromTranscript(newest);
    if (!raw) continue;
    const cwd = path.resolve(raw);
    const prev = seen.get(cwd);
    if (!prev || newestMs > prev.lastMs) seen.set(cwd, { name: path.basename(cwd), cwd, lastMs: newestMs });
  }
  return [...seen.values()].sort((a, b) => b.lastMs - a.lastMs);
}

function readPrivList() {
  try {
    const v = JSON.parse(fs.readFileSync(privateListPath(), 'utf8'));
    if (v && typeof v === 'object') {
      return {
        paths: Array.isArray(v.paths) ? v.paths : [],
        visibility: (v.visibility && typeof v.visibility === 'object') ? v.visibility : {},
      };
    }
  } catch { /* missing / broken ≡ empty */ }
  return { paths: [], visibility: {} };
}

ipcMain.handle('list-workspaces', async () => {
  const list = readPrivList();
  return { workspaces: discoverWorkspaces(), visibility: list.visibility };
});

ipcMain.handle('set-workspace-visibility', async (_, payload) => {
  const cwd = payload && payload.cwd ? path.resolve(payload.cwd) : null;
  const level = payload && payload.level;
  if (!cwd) return { error: 'no cwd' };
  const list = readPrivList();
  if (VIS_LEVELS.includes(level)) list.visibility[cwd] = level;
  else delete list.visibility[cwd]; // anything else ≡ clear override → default
  list.paths = (list.paths || []).filter((p) => p !== cwd);
  try {
    fs.mkdirSync(path.dirname(privateListPath()), { recursive: true });
    fs.writeFileSync(privateListPath(), JSON.stringify(list, null, 2));
    return { ok: true, visibility: list.visibility };
  } catch (e) {
    return { error: e.message };
  }
});

// ── Log tail ─────────────────────────────────────────────────────────────────
ipcMain.handle('tail-log', async () => {
  const p = daemonLogPath();
  try {
    if (!fs.existsSync(p)) return { path: p, content: '' };
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.split('\n');
    const tail = lines.slice(-80).join('\n');
    return { path: p, content: tail };
  } catch (e) {
    return { path: p, content: `error: ${e.message}` };
  }
});

// ── Variables (for autocomplete) ─────────────────────────────────────────────
// Calls `claude-rpc vars`, which emits the same JSON shape the previous
// inline-ESM helper produced — works identically in dev and packaged modes.
ipcMain.handle('list-vars', async () => {
  const cli = resolveCli();
  if (cli.kind === 'missing') return { vars: [], live: null };
  try {
    const result = spawnSync(cli.path, (cli.args || []).concat(['vars']), {
      cwd: cli.cwd || process.cwd(),
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    if (result.status !== 0) return { vars: [], live: null };
    return JSON.parse(result.stdout.trim());
  } catch {
    return { vars: [], live: null };
  }
});

// ── Local server ─────────────────────────────────────────────────────────────
// One `claude-rpc serve` for the Stats tab and the tray's "Open web dashboard".
// It runs with CLAUDE_RPC_NO_OPEN so the server never opens a browser itself.
// Callers decide what to show. stdio is 'ignore' because nothing reads it.
function portIsOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (open) => { sock.destroy(); resolve(open); };
    sock.setTimeout(500, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Resolves true once the server accepts connections (or within ~5s, false).
async function ensureServe() {
  const port = resolveRpcPort();
  if (await portIsOpen(port)) return true; // ours, or one the user started
  if (!serveChild) {
    const cli = resolveCli();
    if (cli.kind === 'missing') return false;
    const child = spawn(cli.path, (cli.args || []).concat(['serve']), {
      cwd: cli.cwd || process.cwd(),
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      env: { ...process.env, CLAUDE_RPC_NO_OPEN: '1' },
    });
    child.on('error', () => {});
    child.on('exit', () => { if (serveChild === child) serveChild = null; });
    child.unref();
    serveChild = child;
  }
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await portIsOpen(port)) return true;
    if (!serveChild) return false; // it exited without ever listening
  }
  return false;
}

ipcMain.handle('start-serve', async () => {
  const ready = await ensureServe();
  return { ok: ready };
});

ipcMain.handle('get-rpc-port', () => resolveRpcPort());

ipcMain.handle('get-app-version', () => app.getVersion());

ipcMain.handle('open-external', async (_, url) => ({ ok: openExternalSafe(url) }));

function stopServe() {
  if (!serveChild) return;
  try {
    // POSIX: the detached child leads its own process group, so kill the
    // group. Windows has no process groups to signal (process.kill(-pid)
    // throws), and the child is the serve process itself, so kill it directly.
    if (process.platform === 'win32') serveChild.kill();
    else process.kill(-serveChild.pid);
  } catch { /* already gone */ }
  serveChild = null;
}

function cleanup() {
  stopServe();
  if (updateCheckTimer) clearInterval(updateCheckTimer);
}

app.on('before-quit', () => { app.isQuitting = true; cleanup(); });

app.on('window-all-closed', () => {
  // With a tray, closing the window hides it and the app stays resident.
  // Only exit here if the tray never came up (e.g. the icon was missing),
  // so the app can't get stuck running headless with no way back in.
  if (!tray) { cleanup(); app.quit(); }
});
