// Claude RPC desktop app — a thin shell around the CLI it bundles.
//
// Everything the user sees is the CLI's own local web dashboard: this process
// starts `claude-rpc serve` and points a window at its /settings page, so the
// desktop app and `claude-rpc settings` are the same UI and can't drift. What
// lives here is only what a browser tab can't do: first-run `setup` (the
// reason the installer exists), a tray icon with daemon controls, and
// auto-update of the app + bundled CLI.
const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const resolveRpcPort = require('./port.js');

// Lazy-require electron-updater so dev mode (where the dep may not be
// installed yet) doesn't crash on import. It's only meaningful in a
// packaged app anyway.
function loadAutoUpdater() {
  try { return require('electron-updater').autoUpdater; }
  catch { return null; }
}

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
// Three runtime modes the app can land in:
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

const PAGE_BG = '#f4ede0'; // the dashboard's --paper, so the window never flashes dark

const baseUrl = () => `http://127.0.0.1:${resolveRpcPort()}`;

function daemonPidPath() { return path.join(os.tmpdir(), 'claude-rpc', 'daemon.pid'); }

function daemonRunning() {
  try {
    const pid = Number(fs.readFileSync(daemonPidPath(), 'utf8'));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

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

// The running server must be one that has the settings page: a dashboard left
// over from an older claude-rpc answers on the port but 404s /settings.
async function settingsPageReady() {
  try {
    const res = await fetch(`${baseUrl()}/api/settings`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

// Shown in the window when the dashboard can't be reached. Plain inline HTML:
// there is no server to load anything from at this point.
function problemPage(title, detail) {
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<!doctype html><meta charset="utf-8"><title>Claude RPC</title>
<body style="margin:0;background:${PAGE_BG};color:#1a1611;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh">
<div style="max-width:440px;padding:24px;border:2px solid #1a1611;background:#fff;box-shadow:3px 3px 0 #1a1611">
<h1 style="font-size:18px;margin:0 0 8px">${esc(title)}</h1><p style="margin:0;color:#5c5147">${esc(detail)}</p></div>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// Start the dashboard server if needed and show its settings page.
async function loadSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const cli = resolveCli();
  if (cli.kind === 'missing') {
    mainWindow.loadURL(problemPage('The claude-rpc program is missing', 'Reinstall Claude RPC to restore it.'));
    return;
  }
  if (!(await ensureServe())) {
    mainWindow.loadURL(problemPage("Couldn't start the dashboard",
      `Nothing answered on port ${resolveRpcPort()}. Quit Claude RPC from the tray and open it again.`));
    return;
  }
  if (!(await settingsPageReady())) {
    mainWindow.loadURL(problemPage('An older dashboard is still running',
      `Something from a previous claude-rpc version is using port ${resolveRpcPort()}. Close it (or restart your computer), then reopen Claude RPC.`));
    return;
  }
  if (mainWindow.isDestroyed()) return;
  mainWindow.loadURL(`${baseUrl()}/settings`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 860,
    backgroundColor: PAGE_BG,
    title: 'Claude RPC',
    autoHideMenuBar: true,
    show: false,
    // No preload and no IPC: the page is the same one a browser tab gets, and
    // talks only to the local dashboard server over HTTP.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // Show something immediately; the server can take a second to come up.
  mainWindow.loadURL(problemPage('Starting…', 'Opening your settings.'));
  loadSettings();

  // The window only ever shows the local dashboard. Anything else — a link in
  // the page, target=_blank — opens in the OS browser instead.
  const isLocal = (url) => url.startsWith(`${baseUrl()}/`) || url.startsWith('data:text/html');
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (isLocal(url)) return;
    e.preventDefault();
    openExternalSafe(url);
  });
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
  // The server may have been stopped since the page loaded (it dies with a
  // crashed CLI, or the user killed it): bring it back rather than show a
  // dead page.
  portIsOpen(resolveRpcPort()).then((open) => { if (!open) loadSettings(); });
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

// Tray icon + right-click menu. Rebuilding the menu after each daemon action
// keeps the running/stopped label honest.
function rebuildTrayMenu() {
  if (!tray) return;
  const running = daemonRunning();
  const later = () => setTimeout(rebuildTrayMenu, 800);
  const menu = Menu.buildFromTemplate([
    { label: running ? '● Daemon running' : '○ Daemon stopped', enabled: false },
    { type: 'separator' },
    { label: 'Settings', click: () => showWindow() },
    { label: 'Open stats in browser', click: async () => {
      if (await ensureServe()) openExternalSafe(baseUrl());
    } },
    { type: 'separator' },
    { label: 'Start daemon',   enabled: !running, click: async () => { await runCli(['start'], { detached: true }); later(); } },
    { label: 'Stop daemon',    enabled: running,  click: async () => { await runCli(['stop']);    rebuildTrayMenu(); } },
    { label: 'Restart daemon', enabled: running,  click: async () => { await runCli(['restart']); later(); } },
    { label: 'Run setup again', click: async () => { await runSetup({ auto: false }); later(); } },
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
  // The daemon can be started or stopped from the settings page or a
  // terminal, so refresh the label whenever the menu is about to be used.
  tray.on('mouse-enter', rebuildTrayMenu);
  tray.on('right-click', rebuildTrayMenu);
  rebuildTrayMenu();
}

app.whenReady().then(() => {
  if (!isPrimaryInstance) return; // quitting; the first instance has been focused
  createWindow();
  createTray();
  // macOS: clicking the Dock icon after the window was closed to the tray
  // brings it back (and re-creates it if it was destroyed).
  app.on('activate', () => showWindow());
  initAutoUpdater();
  // First-run setup — THE reason the installer exists. Without it the app is
  // just a settings window: hooks never get wired, the daemon never starts,
  // no card ever appears. Deferred a beat so the window paints first.
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
  await runSetup({ auto: true, version });
}

// Run the CLI's `setup` and tell the user how it went. Success is quiet when
// automatic (the settings page already shows the daemon running) and
// confirmed when they asked for it from the tray. Failure always says so,
// with the tail of what setup printed.
async function runSetup({ auto, version }) {
  const result = await runCli(['setup']);
  const v = version || await cliVersion();
  if (result.ok && v) markSetupDone(v);
  rebuildTrayMenu();
  // Reload so the page shows the daemon setup just started.
  if (result.ok && mainWindow && !mainWindow.isDestroyed()) loadSettings();
  if (result.ok && auto) return;
  // Strip the CLI's colour codes; a dialog shows them as garbage.
  const output = String(result.output || '').replace(/\x1b\[[0-9;]*m/g, '').trim().slice(-1500);
  const opts = result.ok
    ? { type: 'info', title: 'Setup finished', message: 'Claude RPC is set up.', detail: 'Hooks are wired into Claude Code and the daemon is running.' }
    : { type: 'error', title: "Setup didn't finish", message: "Claude RPC couldn't finish setting itself up.", detail: output || 'No output from setup.' };
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  if (win) dialog.showMessageBox(win, { buttons: ['OK'], ...opts });
  else dialog.showMessageBox({ buttons: ['OK'], ...opts });
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
