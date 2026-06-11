// Claude RPC — Claude Code status in the VS Code status bar.
//
// A VIEWER over claude-rpc's state files, not a second presence pipeline:
// Claude Code's hooks write state.json (tmpdir), the scanner writes
// aggregate.json (~/.claude-rpc), and the daemon owns Discord. This extension
// reads those same files, renders a status bar item, and offers pause/resume
// by writing the same pause.json marker the CLI does. It never reports
// editor activity anywhere — it has no network surface at all beyond the
// optional localhost dashboard probe.
'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const core = require('./status-core.js');

const STATE_DIR = path.join(os.tmpdir(), 'claude-rpc');
const STATE_PATH = path.join(STATE_DIR, 'state.json');
const PAUSE_PATH = path.join(STATE_DIR, 'pause.json');
const PID_PATH = path.join(STATE_DIR, 'daemon.pid');
const AGG_DIR = path.join(os.homedir(), '.claude-rpc');
const AGG_PATH = path.join(AGG_DIR, 'aggregate.json');
const DASHBOARD_URL = 'http://127.0.0.1:47474';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function pausedUntil(now = Date.now()) {
  const raw = readJson(PAUSE_PATH);
  const until = Number(raw?.until);
  return Number.isFinite(until) && until > now ? until : 0;
}

function daemonRunning() {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf8'));
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

// Is the claude-rpc CLI on PATH? Cached for a minute — it's consulted on
// every render to decide between the live view and the setup prompt, and
// to pick `claude-rpc …` vs `npx claude-rpc@latest …` for terminal actions.
let cliCache = { ts: 0, ok: false };
function cliAvailable() {
  if (Date.now() - cliCache.ts < 60_000) return cliCache.ok;
  let ok = false;
  try {
    cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude-rpc'],
      { stdio: 'ignore', timeout: 1500 });
    ok = true;
  } catch { /* not installed (or `which` itself missing) — treat as absent */ }
  cliCache = { ts: Date.now(), ok };
  return ok;
}

// Terminal command for CLI actions — falls back to npx when the global
// install is absent, so every menu action works on a marketplace-only setup.
function cliCmd(args) {
  return (cliAvailable() ? 'claude-rpc ' : 'npx claude-rpc@latest ') + args;
}

// Setup is needed when claude-rpc has left no trace at all: no live state,
// no lifetime aggregate, and no CLI on PATH. Any one of those existing means
// the pairing works (e.g. CLI uninstalled but old stats remain → show them).
function setupNeeded() {
  return !fs.existsSync(STATE_PATH) && !fs.existsSync(AGG_PATH) && !cliAvailable();
}

// aggregate.json can be MBs — only re-read when its mtime moves.
let aggCache = { mtime: 0, value: null };
function readAggregate() {
  let st;
  try { st = fs.statSync(AGG_PATH); } catch { return aggCache.value; }
  if (st.mtimeMs !== aggCache.mtime) {
    aggCache = { mtime: st.mtimeMs, value: readJson(AGG_PATH) };
  }
  return aggCache.value;
}

function activate(context) {
  // Priority decides left-to-right placement among left-aligned items —
  // higher is further left. It's fixed at creation time, so a priority
  // change from settings recreates the item.
  let item = null;
  let itemPriority = null;
  function ensureItem() {
    const priority = vscode.workspace.getConfiguration('claudeRpc').get('statusBarPriority', 10000);
    if (item && itemPriority === priority) return;
    const old = item;
    item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
    item.command = 'claudeRpc.menu';
    itemPriority = priority;
    if (old) old.dispose();
  }
  ensureItem();
  context.subscriptions.push({ dispose: () => item?.dispose() });

  function render() {
    const cfg = vscode.workspace.getConfiguration('claudeRpc');
    const needsSetup = setupNeeded();
    const view = core.buildView(readJson(STATE_PATH), readAggregate(), pausedUntil(), {
      showTokens: cfg.get('showTokens', true),
      hideWhenStale: cfg.get('hideWhenStale', false),
      setupNeeded: needsSetup,
    });
    if (view.hidden) { item.hide(); return; }
    item.text = `$(${view.icon}) ${view.label}`;
    item.backgroundColor = view.warning
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    const md = new vscode.MarkdownString(
      view.tooltipLines.join('  \n')
      + (needsSetup ? '' : `\n\nDaemon: ${daemonRunning() ? '● running' : '○ not running'}`)
      + '\n\n[Menu](command:claudeRpc.menu) · [Dashboard](command:claudeRpc.openDashboard)',
    );
    md.isTrusted = true;
    item.tooltip = md;
    item.show();
  }

  // File watchers for instant updates; the poll below is the fallback (and
  // refreshes elapsed-time text). Both state dirs may not exist yet on a
  // machine that hasn't run claude-rpc — retry attachment from the poll.
  const watchers = new Map(); // dir → fs.FSWatcher
  function attachWatch(dir, names) {
    if (watchers.has(dir) || !fs.existsSync(dir)) return;
    try {
      const w = fs.watch(dir, (event, filename) => {
        if (filename && !names.has(filename)) return;
        render();
      });
      w.on('error', () => { try { w.close(); } catch { /* already closed */ } watchers.delete(dir); });
      watchers.set(dir, w);
    } catch { /* dir vanished between existsSync and watch — poll retries */ }
  }
  function attachAll() {
    attachWatch(STATE_DIR, new Set([path.basename(STATE_PATH), path.basename(PAUSE_PATH)]));
    attachWatch(AGG_DIR, new Set([path.basename(AGG_PATH)]));
  }

  let timer = null;
  function schedule() {
    if (timer) clearInterval(timer);
    const sec = Math.max(1, vscode.workspace.getConfiguration('claudeRpc').get('pollIntervalSec', 3));
    timer = setInterval(() => { attachAll(); render(); }, sec * 1000);
  }
  context.subscriptions.push({ dispose: () => { clearInterval(timer); for (const w of watchers.values()) { try { w.close(); } catch { /* noop */ } } } });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('claudeRpc')) { ensureItem(); schedule(); render(); }
  }));

  // ── Commands ─────────────────────────────────────────────────────────────

  function writePause(ms) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(PAUSE_PATH, JSON.stringify({ until: Date.now() + ms }));
      render();
    } catch (e) {
      vscode.window.showErrorMessage(`claude-rpc: could not write pause marker: ${e.message}`);
    }
  }

  async function pauseCmd() {
    const pick = await vscode.window.showQuickPick(
      [
        { label: '30 minutes', ms: 30 * 60_000 },
        { label: '1 hour', ms: 60 * 60_000 },
        { label: '2 hours', ms: 2 * 60 * 60_000 },
        { label: '8 hours', ms: 8 * 60 * 60_000 },
      ],
      { placeHolder: 'Pause the Discord card for…' },
    );
    if (pick) writePause(pick.ms);
  }

  function resumeCmd() {
    try { fs.unlinkSync(PAUSE_PATH); } catch { /* wasn't paused */ }
    render();
  }

  async function openDashboardCmd() {
    // Probe the local stats server first; if it isn't up, offer to start it
    // in a terminal (keeps the server's lifetime visible and user-owned).
    let up = false;
    try {
      const res = await fetch(`${DASHBOARD_URL}/api/state`, { signal: AbortSignal.timeout(800) });
      up = res.ok;
    } catch { /* not running */ }
    if (up) {
      vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
      return;
    }
    const start = await vscode.window.showInformationMessage(
      'The claude-rpc dashboard server isn\'t running.', 'Start it in a terminal',
    );
    if (start) {
      const term = vscode.window.createTerminal('claude-rpc dashboard');
      term.show();
      term.sendText(cliCmd('serve'));
    }
  }

  function runInTerminal(name, command) {
    const term = vscode.window.createTerminal(name);
    term.show();
    term.sendText(command);
  }

  async function menuCmd() {
    // Marketplace-only install (no CLI, no state): the menu IS the onboarding.
    if (setupNeeded()) {
      const items = [
        { label: '$(rocket) Set up claude-rpc (one command)', detail: 'npx claude-rpc@latest setup — installs, wires Claude Code\'s hooks, starts the Discord daemon', act: () => runInTerminal('claude-rpc setup', 'npx claude-rpc@latest setup') },
        { label: '$(globe) What is claude-rpc?', act: () => vscode.env.openExternal(vscode.Uri.parse('https://claude-rpc.vercel.app/?ref=vscode')) },
        { label: '$(refresh) Refresh', act: render },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Claude RPC — companion CLI not detected' });
      if (pick) await pick.act();
      return;
    }

    const paused = pausedUntil();
    const daemon = daemonRunning();
    const items = [];
    if (paused) items.push({ label: '$(debug-start) Resume Discord presence', act: resumeCmd });
    else items.push({ label: '$(debug-pause) Pause Discord presence…', act: pauseCmd });
    items.push({ label: '$(dashboard) Open dashboard', act: openDashboardCmd });
    if (!daemon) {
      items.push({
        label: '$(play) Start the claude-rpc daemon',
        act: () => runInTerminal('claude-rpc', cliCmd('start')),
      });
    }
    items.push({ label: '$(refresh) Refresh', act: render });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `Claude RPC — daemon ${daemon ? 'running' : 'not running'}${paused ? ' · Discord paused' : ''}`,
    });
    if (pick) await pick.act();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeRpc.menu', menuCmd),
    vscode.commands.registerCommand('claudeRpc.pause', pauseCmd),
    vscode.commands.registerCommand('claudeRpc.resume', resumeCmd),
    vscode.commands.registerCommand('claudeRpc.openDashboard', openDashboardCmd),
  );

  attachAll();
  render();
  schedule();
}

function deactivate() { /* disposables handle cleanup */ }

module.exports = { activate, deactivate };
