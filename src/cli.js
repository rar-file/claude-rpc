#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, watchFile, unlinkSync } from 'node:fs';
import process from 'node:process';

// Force the console code page to UTF-8 (65001) on Windows so Unicode box
// drawing, block elements, and other chars render correctly. Default cmd.exe
// code page on Win10 is 437/850, which displays many of our chars as `?`.
// Hook events (no TTY) skip this — they don't print anything user-visible.
if (process.platform === 'win32' && process.stdout.isTTY) {
  try { spawnSync('chcp.com', ['65001'], { stdio: 'ignore', windowsHide: true }); } catch {}
}
import { DAEMON_SCRIPT, PID_PATH, STATE_PATH, LOG_PATH, AGGREGATE_PATH, CONFIG_PATH, IS_PACKAGED, EXE_PATH, CANONICAL_EXE } from './paths.js';
import { readState } from './state.js';
import { buildVars, fillTemplate, humanProject, humanTool, applyIdle, framePasses } from './format.js';
import { scan, readAggregate, findLiveSessions, dayKey, weekKey } from './scanner.js';
import { runHookCli } from './hook.js';
import { install as runInstall, uninstall as runUninstall, isInstalled, migrateConfig, installHooks, ensureCanonicalExe } from './install.js';
import { startTui } from './tui.js';
import { generateInsights } from './insights.js';
import { badgeSvg } from './badge.js';
import { fmtCost } from './pricing.js';
import { addPrivateCwd, removePrivateCwd, listPrivateCwds, resolveVisibility } from './privacy.js';
import { loadConfig, hasUserConfig } from './config.js';
import { VERSION } from './version.js';
import { fail, EX_USER_ERROR, EX_BAD_STATE } from './ui.js';
import { basename } from 'node:path';

const cmd = process.argv[2];

// ── ANSI styling (degrades gracefully) ────────────────────────────────────────
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: tty ? '\x1b[0m' : '',
  dim: tty ? '\x1b[2m' : '',
  bold: tty ? '\x1b[1m' : '',
  cyan: tty ? '\x1b[36m' : '',
  green: tty ? '\x1b[32m' : '',
  yellow: tty ? '\x1b[33m' : '',
  red: tty ? '\x1b[31m' : '',
  magenta: tty ? '\x1b[35m' : '',
  blue: tty ? '\x1b[34m' : '',
  gray: tty ? '\x1b[90m' : '',
};
const ansiRe = /\x1b\[[0-9;]*m/g;
const visibleLen = (s) => String(s).replace(ansiRe, '').length;

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function daemonPid() {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number(readFileSync(PID_PATH, 'utf8'));
  return pid && isAlive(pid) ? pid : null;
}

function startDaemon({ quiet = false } = {}) {
  const pid = daemonPid();
  if (pid) {
    if (!quiet) console.log(`${c.yellow}!${c.reset} Daemon already running (pid ${pid}). Run 'stop' first to restart.`);
    return false;
  }
  // In packaged mode the "daemon script" is the exe itself with a subcommand;
  // in dev mode it's the src/daemon.js path passed to node. Prefer the
  // canonical exe when it exists so we don't keep the user's Downloads copy
  // locked open — the canonical install is the long-lived path.
  const exe = (IS_PACKAGED && existsSync(CANONICAL_EXE)) ? CANONICAL_EXE : process.execPath;
  const args = IS_PACKAGED ? ['daemon'] : [DAEMON_SCRIPT];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  if (!quiet) console.log(`${c.green}✓${c.reset} Daemon launched (pid ${c.cyan}${child.pid}${c.reset})  ${c.dim}logs: ${LOG_PATH}${c.reset}`);
  return true;
}

function stopDaemon({ quiet = false } = {}) {
  const pid = daemonPid();
  if (!pid) { if (!quiet) console.log('Daemon not running.'); return false; }
  try {
    process.kill(pid, 'SIGTERM');
    if (!quiet) console.log(`${c.green}✓${c.reset} Sent SIGTERM to pid ${c.cyan}${pid}${c.reset}`);
    return true;
  } catch (e) {
    if (!quiet) console.log(`${c.red}✗${c.reset} Failed to stop: ${e.message}`);
    return false;
  }
}

function restartDaemon() {
  if (stopDaemon({ quiet: true })) {
    // wait briefly for the OS to release the pid file, then spawn fresh
    setTimeout(() => startDaemon(), 600);
  } else {
    startDaemon();
  }
}

// ── Box drawing — auto-widens to fit longest line ────────────────────────────
function box(title, lines, minWidth = 64) {
  const longest = lines.reduce((m, l) => Math.max(m, visibleLen(l)), 0);
  const termWidth = process.stdout.columns || 100;
  const maxAllowed = Math.max(40, termWidth - 2);
  const width = Math.min(maxAllowed, Math.max(minWidth, longest + 4, title.length + 8));
  const top    = `${c.gray}┌─ ${c.reset}${c.bold}${title}${c.reset} ${c.gray}${'─'.repeat(Math.max(0, width - 4 - title.length))}┐${c.reset}`;
  const bottom = `${c.gray}└${'─'.repeat(width - 2)}┘${c.reset}`;
  console.log(top);
  for (const raw of lines) {
    const truncated = truncateAnsi(raw, width - 4);
    const pad = Math.max(1, width - 2 - visibleLen(truncated));
    console.log(`${c.gray}│${c.reset} ${truncated}${' '.repeat(pad - 1)}${c.gray}│${c.reset}`);
  }
  console.log(bottom);
}

// Truncate a string to `max` visible chars, keeping ANSI codes intact.
function truncateAnsi(str, max) {
  if (visibleLen(str) <= max) return str;
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < str.length && visible < max - 1) {
    if (str[i] === '\x1b' && str[i + 1] === '[') {
      const end = str.indexOf('m', i);
      if (end !== -1) { out += str.slice(i, end + 1); i = end + 1; continue; }
    }
    out += str[i]; visible++; i++;
  }
  return out + '…' + c.reset;
}

function shortPath(p) {
  if (!p) return '';
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

// 24-bar histogram of hour-of-day activity.
function renderHourHistogram(byHour, opts = {}) {
  const heightChars = ' ▁▂▃▄▅▆▇█';
  let max = 0;
  for (let h = 0; h < 24; h++) max = Math.max(max, byHour?.[h]?.activeMs || 0);
  if (max <= 0) return ['  (no hourly data yet)'];
  const bars = [];
  for (let h = 0; h < 24; h++) {
    const ms = byHour?.[h]?.activeMs || 0;
    const idx = ms > 0 ? Math.max(1, Math.min(8, Math.round((ms / max) * 8))) : 0;
    bars.push(heightChars[idx]);
  }
  const peakH = opts.peakHour ?? bars.findIndex((b) => b === heightChars[Math.min(8, ...bars.map((_, i) => i).filter(() => true))]);
  const colored = bars.map((ch, h) => h === opts.peakHour ? `${c.magenta}${c.bold}${ch}${c.reset}` : `${c.green}${ch}${c.reset}`).join('');
  // Hour labels under every 3rd hour.
  const labels = '00  03  06  09  12  15  18  21  ';
  return [
    `  ${colored}`,
    `  ${c.dim}${labels}${c.reset}`,
  ];
}

// Bar chart for an array of [label, value] entries.
function renderBars(rows, opts = {}) {
  if (!rows.length) return ['  (none yet)'];
  const max = rows[0][1];
  const labelWidth = opts.labelWidth || 20;
  return rows.map(([label, val]) => {
    const shown = label.length > labelWidth ? label.slice(0, labelWidth - 1) + '…' : label;
    return `${shown.padEnd(labelWidth)} ${bar(val, max)} ${c.cyan}${typeof val === 'number' ? val.toLocaleString() : val}${c.reset}`;
  });
}

// GitHub-style heatmap of last N days. Cells colored by activeMs intensity.
function renderHeatmap(byDay, days = 91) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Walk back N-1 days and snap to the previous Sunday so columns align.
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));
  while (start.getDay() !== 0) start.setDate(start.getDate() - 1);

  // Collect cells column-by-column (week = column, weekday = row).
  const cells = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const k = dayKey(cursor.getTime());
    cells.push({ key: k, ms: byDay?.[k]?.activeMs || 0, future: cursor > today });
    cursor.setDate(cursor.getDate() + 1);
  }
  const cols = Math.ceil(cells.length / 7);

  // Quantize: 0 / >0 / >15m / >1h / >3h
  const shade = (ms) => {
    if (ms <= 0) return `${c.dim}·${c.reset}`;
    if (ms < 15 * 60_000) return `${c.gray}▪${c.reset}`;
    if (ms < 60 * 60_000) return `${c.green}▪${c.reset}`;
    if (ms < 3 * 3600_000) return `${c.green}${c.bold}▪${c.reset}`;
    return `${c.magenta}${c.bold}▪${c.reset}`;
  };

  // Month labels along the top (where the month changes within the visible window).
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const labelRow = new Array(cols).fill('  ');
  let lastMonth = -1;
  for (let col = 0; col < cols; col++) {
    const first = cells[col * 7];
    if (!first) continue;
    const d = new Date(first.key + 'T00:00:00');
    if (d.getMonth() !== lastMonth) {
      labelRow[col] = months[d.getMonth()];
      lastMonth = d.getMonth();
    }
  }
  // Build header (3-letter months stretched across columns).
  const header = labelRow.map((s) => (s + '   ').slice(0, 2)).join(' ');

  const dayLabels = [' ', 'M', ' ', 'W', ' ', 'F', ' '];
  const lines = [`     ${c.dim}${header}${c.reset}`];
  for (let row = 0; row < 7; row++) {
    let line = `  ${c.dim}${dayLabels[row]}${c.reset}  `;
    for (let col = 0; col < cols; col++) {
      const cell = cells[col * 7 + row];
      if (!cell || cell.future) line += '  ';
      else line += shade(cell.ms) + ' ';
    }
    lines.push(line);
  }

  // Footer legend.
  const legend = `     ${c.dim}less${c.reset}  ${c.dim}·${c.reset} ${c.gray}▪${c.reset} ${c.green}▪${c.reset} ${c.green}${c.bold}▪${c.reset} ${c.magenta}${c.bold}▪${c.reset}  ${c.dim}more${c.reset}`;
  lines.push('');
  lines.push(legend);
  return lines;
}

function pair(label, value, valueColor = c.cyan) {
  return `${c.dim}${label.padEnd(14)}${c.reset} ${valueColor}${value}${c.reset}`;
}

// ASCII bar for a value relative to max.
function bar(val, max, width = 22) {
  if (!max || max <= 0) return '';
  const filled = Math.max(0, Math.min(width, Math.round((val / max) * width)));
  return `${c.magenta}${'█'.repeat(filled)}${c.dim}${'░'.repeat(width - filled)}${c.reset}`;
}

function showStatus() {
  const state = readState();
  const aggregate = readAggregate();
  const config = loadConfig();
  const live = findLiveSessions({ thresholdMs: 90_000 });
  state.liveSessions = live;
  const vars = buildVars(state, config, aggregate);
  const pid = daemonPid();

  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ Claude RPC${c.reset}  ${c.dim}— Discord Rich Presence for Claude Code${c.reset}`);
  console.log('');

  box('daemon', [
    pair('status',  pid ? `${c.green}● running${c.reset}  pid ${pid}` : `${c.red}○ not running${c.reset}`, ''),
    pair('client',  config.clientId || '—'),
    pair('config',  shortPath(CONFIG_PATH), c.gray),
    pair('state',   shortPath(STATE_PATH), c.gray),
    pair('log',     shortPath(LOG_PATH), c.gray),
  ]);
  console.log('');

  box('current session', [
    pair('status',    vars.statusVerbose, statusColor(vars.status)),
    pair('project',   vars.project),
    pair('model',     vars.modelPretty),
    pair('duration',  vars.duration),
    pair('messages',  String(vars.messages), c.yellow),
    pair('tool calls', String(vars.tools), c.yellow),
    pair('files',     `${vars.filesOpened} opened · ${vars.filesEdited} edited · ${vars.filesRead} read`),
    pair('tokens',    `${c.bold}${vars.tokensFmt}${c.reset}  ${c.dim}(${vars.inputTokens} in · ${vars.outputTokens} out · ${vars.cacheTokens} cache)${c.reset}`),
  ]);
  console.log('');

  if (live.length) {
    const lines = live.slice(0, 6).map((s) => {
      const proj = humanProject(s.cwd || s.project);
      return `${c.cyan}${(proj || '—').padEnd(20)}${c.reset} ${c.dim}modified ${s.ageSec}s ago${c.reset}`;
    });
    box(`live sessions (${live.length})`, lines);
    console.log('');
  }

  if (aggregate) {
    box('today', [
      pair('active',     `${c.bold}${c.green}${vars.todayHours}${c.reset}`, ''),
      pair('prompts',    String(vars.todayPrompts), c.yellow),
      pair('tool calls', vars.todayToolsFmt, c.yellow),
      pair('sessions',   String(vars.todaySessions || 0)),
      pair('tokens',     `${c.bold}${vars.todayTokensFmt}${c.reset}  ${c.dim}grand total${c.reset}`, ''),
      pair('  in+out',   vars.todayTokensRealFmt, c.gray),
      pair('  cache',    vars.todayCacheTokensFmt, c.gray),
    ]);
    console.log('');

    box('streak', [
      pair('current',   `${c.bold}${c.magenta}${vars.streak}${c.reset} ${c.dim}days${c.reset}`, ''),
      pair('longest',   `${vars.longestStreak} ${c.dim}days${c.reset}`, c.cyan),
      pair('day no.',   String(vars.daysSinceFirst), c.cyan),
      pair('best day',  vars.bestDayDate ? `${c.bold}${vars.bestDayHours}${c.reset}  ${c.dim}on ${vars.bestDayDate} · ${vars.bestDayPrompts} prompts${c.reset}` : '—', ''),
    ]);
    console.log('');

    box('all-time on claude', [
      pair('active',     `${c.bold}${c.green}${vars.allHours}${c.reset}  ${c.dim}(${vars.allWallHours} wall clock)${c.reset}`, ''),
      pair('sessions',   `${vars.allSessions}  ${c.dim}(+${vars.allSubagentRuns} subagent runs)${c.reset}`, c.yellow),
      pair('prompts',    vars.allMessages.toLocaleString(), c.yellow),
      pair('tool calls', vars.allTools.toLocaleString(), c.yellow),
      pair('files',      vars.allFiles.toLocaleString()),
      pair('tokens',     `${c.bold}${c.magenta}${vars.allTokensFmt}${c.reset}  ${c.dim}grand total — in + out + cache${c.reset}`, ''),
      pair('  input',    vars.allInputTokens, c.gray),
      pair('  output',   vars.allOutputTokens, c.gray),
      pair('  cache read',  vars.allCacheReadTokens, c.gray),
      pair('  cache write', vars.allCacheWriteTokens, c.gray),
      pair('  billable', `${vars.allBillableFmt}  ${c.dim}(in + out + cache writes)${c.reset}`, c.dim),
    ]);
    console.log('');

    // 13-week heatmap of activity (rounded up to the nearest Sunday).
    if (aggregate.byDay && Object.keys(aggregate.byDay).length) {
      box('activity · last 13 weeks', renderHeatmap(aggregate.byDay, 91), 56);
      console.log('');
    }

    // Hour-of-day histogram (when do you code?).
    if (aggregate.byHour && Object.keys(aggregate.byHour).length) {
      box('when you code · hour of day', renderHourHistogram(aggregate.byHour, { peakHour: vars.peakHourNum }), 40);
      console.log('');
    }

    // Top edited files.
    if (aggregate.topEditedFiles && aggregate.topEditedFiles.length) {
      const top = aggregate.topEditedFiles.slice(0, 8).map((e) => [basename(e.path), e.count]);
      box('most-edited files', renderBars(top, { labelWidth: 22 }));
      console.log('');
    }

    // Top tools as a tiny bar chart.
    const tools = Object.entries(aggregate.toolBreakdown || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    if (tools.length) {
      const max = tools[0][1];
      const lines = tools.map(([name, count]) => {
        const pretty = humanTool(name).slice(0, 18);
        return `${pretty.padEnd(20)} ${bar(count, max)} ${c.cyan}${count.toLocaleString()}${c.reset}`;
      });
      box('top tools', lines);
      console.log('');
    }

    // Top projects.
    const projects = aggregate.projects || {};
    const top = Object.entries(projects)
      .sort((a, b) => b[1].activeMs - a[1].activeMs)
      .slice(0, 6);
    if (top.length) {
      const maxMs = top[0][1].activeMs;
      const lines = top.map(([name, p]) => {
        const h = (p.activeMs / 3_600_000);
        const hStr = h < 1 ? `${Math.round(h * 60)}m` : (h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`);
        return `${humanProject(name).slice(0, 20).padEnd(22)} ${bar(p.activeMs, maxMs)} ${c.cyan}${hStr.padStart(5)}${c.reset}  ${c.dim}${p.sessions} sess · ${p.userMessages} prompts${c.reset}`;
      });
      box('top projects by active time', lines, 72);
      console.log('');
    }

    // Code churn — lines added / removed.
    if (aggregate.linesAdded || aggregate.linesRemoved) {
      box('code churn', [
        pair('added',     `${c.green}+${aggregate.linesAdded.toLocaleString()}${c.reset} lines`, ''),
        pair('removed',   `${c.red}−${aggregate.linesRemoved.toLocaleString()}${c.reset} lines`, ''),
        pair('net',       `${c.bold}${vars.linesNetFmt}${c.reset}`, ''),
        pair('today',     `${c.green}+${aggregate.byDay?.[dayKey(Date.now())]?.linesAdded || 0}${c.reset} added`, ''),
      ]);
      console.log('');
    }

    // Top languages by edits.
    const langs = Object.entries(aggregate.languages || {})
      .sort((a, b) => (b[1].edits || 0) - (a[1].edits || 0))
      .slice(0, 6);
    if (langs.length) {
      const max = langs[0][1].edits || 1;
      const lines = langs.map(([name, l]) => `${name.slice(0, 22).padEnd(24)} ${bar(l.edits, max)} ${c.cyan}${l.edits.toLocaleString().padStart(6)}${c.reset}  ${c.dim}${l.files} files${c.reset}`);
      box('languages · by edits', lines);
      console.log('');
    }

    // Top bash commands.
    const bashes = Object.entries(aggregate.bashCommands || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    if (bashes.length) {
      const max = bashes[0][1];
      const lines = bashes.map(([name, n]) => `${name.padEnd(20)} ${bar(n, max)} ${c.cyan}${n.toLocaleString()}${c.reset}`);
      box('top bash commands', lines);
      console.log('');
    }

    // Cost.
    if (aggregate.estimatedCost) {
      const byModel = Object.entries(aggregate.costByModel || {}).sort((a, b) => b[1] - a[1]);
      const max = byModel[0] ? byModel[0][1] : 1;
      const lines = [
        pair('all-time',  `${c.bold}${c.green}${fmtCost(aggregate.estimatedCost)}${c.reset}  ${c.dim}approximate${c.reset}`, ''),
        ...byModel.map(([m, v]) => `${m.padEnd(20)} ${bar(v, max)} ${c.cyan}${fmtCost(v).padStart(8)}${c.reset}`),
      ];
      box('estimated cost', lines);
      console.log('');
    }

    // Insights.
    const insights = generateInsights(aggregate, { limit: 4 });
    if (insights.length) {
      box('insights', insights.map((s) => `${c.dim}→${c.reset} ${s}`));
      console.log('');
    }
  } else {
    console.log(`  ${c.dim}No aggregate yet — run ${c.reset}${c.cyan}claude-rpc scan${c.reset}`);
    console.log('');
  }
}

function showToday() {
  const state = readState();
  const aggregate = readAggregate();
  const config = loadConfig();
  state.liveSessions = findLiveSessions({ thresholdMs: 90_000 });
  const vars = buildVars(state, config, aggregate);

  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ Today${c.reset}  ${c.dim}— ${new Date().toLocaleDateString()}${c.reset}`);
  console.log('');

  box('today', [
    pair('active',     `${c.bold}${c.green}${vars.todayHours}${c.reset}`, ''),
    pair('prompts',    String(vars.todayPrompts), c.yellow),
    pair('tool calls', vars.todayToolsFmt, c.yellow),
    pair('sessions',   String(vars.todaySessions || 0)),
    pair('tokens',     `${c.bold}${vars.todayTokensFmt}${c.reset}  ${c.dim}grand total${c.reset}`, ''),
    pair('  in+out',   vars.todayTokensRealFmt, c.gray),
    pair('  cache',    vars.todayCacheTokensFmt, c.gray),
  ]);
  console.log('');

  if (aggregate?.byHour && Object.keys(aggregate.byHour).length) {
    box('when you code · hour of day', renderHourHistogram(aggregate.byHour, { peakHour: vars.peakHourNum }), 40);
    console.log('');
  }
}

function showWeek() {
  const state = readState();
  const aggregate = readAggregate();
  const config = loadConfig();
  state.liveSessions = findLiveSessions({ thresholdMs: 90_000 });
  const vars = buildVars(state, config, aggregate);

  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ This week${c.reset}  ${c.dim}— ${weekKey(Date.now())}${c.reset}`);
  console.log('');

  box('this week', [
    pair('active',     `${c.bold}${c.green}${vars.weekHours}${c.reset}`, ''),
    pair('prompts',    String(vars.weekPrompts), c.yellow),
    pair('tool calls', vars.weekToolsFmt, c.yellow),
    pair('sessions',   String(vars.weekSessions || 0)),
    pair('tokens',     `${c.bold}${vars.weekTokensFmt}${c.reset}  ${c.dim}grand total${c.reset}`, ''),
  ]);
  console.log('');

  // Current ISO week (Mon → Sun). Future days show "—".
  if (aggregate?.byDay) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const monday = new Date(now);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(d.getDate() + i);
      const k = dayKey(d.getTime());
      const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
      const ms = aggregate.byDay[k]?.activeMs || 0;
      const isFuture = d > now;
      const isToday = k === dayKey(now.getTime());
      days.push({ label: `${dayName} ${k.slice(5)}`, ms, isFuture, isToday });
    }
    const maxMs = Math.max(...days.map((d) => d.ms)) || 1;
    const lines = days.map(({ label, ms, isFuture, isToday }) => {
      if (isFuture) return `${c.dim}${label.padEnd(12)} ${'·'.repeat(22)}     —${c.reset}`;
      const h = ms / 3_600_000;
      const hStr = h < 1 ? `${Math.round(h * 60)}m` : (h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`);
      const prefix = isToday ? `${c.bold}` : '';
      return `${prefix}${label.padEnd(12)}${c.reset} ${bar(ms, maxMs)} ${c.cyan}${hStr.padStart(5)}${c.reset}${isToday ? ` ${c.dim}← today${c.reset}` : ''}`;
    });
    box('this week · daily breakdown', lines);
    console.log('');
  }
}

function statusColor(status) {
  switch (status) {
    case 'working':  return c.green;
    case 'thinking': return c.yellow;
    case 'idle':     return c.gray;
    case 'stale':    return c.dim;
    default:         return c.cyan;
  }
}

function showPreview() {
  let state = readState();
  const aggregate = readAggregate();
  const config = loadConfig();
  const live = findLiveSessions({ thresholdMs: 90_000 });
  state.liveSessions = live;
  state = applyIdle(state, config);
  const vars = buildVars(state, config, aggregate);
  const p = config.presence || {};
  const frames = (Array.isArray(p.rotation) ? p.rotation : [{ details: p.details, state: p.state }]);

  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ Presence preview${c.reset}  ${c.dim}— how Discord renders each rotation frame${c.reset}`);
  console.log('');

  const largeText = p.largeImageText ? fillTemplate(p.largeImageText, vars) : '';
  const smallText = p.smallImageText ? fillTemplate(p.smallImageText, vars) : '';
  console.log(`  ${c.dim}large image:${c.reset} ${c.cyan}${p.largeImageKey || '—'}${c.reset}  ${c.dim}· tooltip:${c.reset} ${largeText}`);
  const smallKey = fillTemplate(p.smallImageKey || '{statusIcon}', vars);
  const smallHidden = !smallKey || smallKey === 'stale' || smallKey.startsWith('{');
  console.log(`  ${c.dim}small image:${c.reset} ${smallHidden ? c.dim + '(hidden)' + c.reset : c.cyan + smallKey + c.reset}  ${c.dim}· tooltip:${c.reset} ${smallText}`);
  console.log('');

  frames.forEach((frame, i) => {
    const passes = framePasses(frame, vars);
    const reqs = frame.requires ? (Array.isArray(frame.requires) ? frame.requires : [frame.requires]) : [];
    const tag = passes
      ? `${c.green}● live${c.reset}`
      : `${c.dim}○ skipped (requires ${reqs.join(', ')})${c.reset}`;
    const details = fillTemplate(frame.details || '', vars);
    const stateLine = fillTemplate(frame.state || '', vars);
    console.log(`  ${c.bold}${String(i + 1).padStart(2)}.${c.reset} ${tag}`);
    console.log(`     ${passes ? c.cyan : c.dim}${details || '—'}${c.reset}`);
    console.log(`     ${passes ? '' : c.dim}${stateLine || '—'}${c.reset}`);
    console.log('');
  });
}

// Emit the autocomplete payload the dashboard needs as JSON, without the
// dashboard having to inline-eval ESM source. Output shape matches the
// previous helper exactly: { vars: [sorted keys], live: <full vars object> }.
function dumpVars() {
  let state = readState();
  const config = loadConfig();
  state.liveSessions = findLiveSessions({ thresholdMs: 90_000 });
  state = applyIdle(state, config);
  const live = buildVars(state, config, readAggregate() || {});
  process.stdout.write(JSON.stringify({ vars: Object.keys(live).sort(), live }));
}

function doScan(force = false) {
  console.log(`${c.dim}Scanning ~/.claude/projects${c.reset}`, force ? '(force re-parse)' : '(incremental)…');
  const t0 = Date.now();
  let lastReport = 0;
  const result = scan({
    force,
    onProgress: ({ scanned, total }) => {
      if (Date.now() - lastReport > 500) {
        process.stdout.write(`\r  parsed ${scanned}/${total}…`);
        lastReport = Date.now();
      }
    },
  });
  process.stdout.write('\n');
  console.log(`${c.green}✓${c.reset} Done in ${Date.now() - t0}ms — ${c.cyan}${result.scanned}${c.reset} parsed · ${result.skipped} cached · ${result.removed} removed (${result.total} total)`);
  if (result.dirs && result.dirs.length > 1) {
    console.log(`${c.dim}Scanned roots:${c.reset} ${result.dirs.join(', ')}`);
  }
  console.log(`${c.dim}Aggregate written to ${AGGREGATE_PATH}${c.reset}`);
}

// Backfill from any folder that has .jsonl transcripts. Useful for:
//   • restoring from a backup of ~/.claude
//   • merging transcripts from another machine
//   • importing data from an older Claude Code install with a non-default path
//
// Walks the given path recursively, adds every .jsonl to the existing cache,
// and rebuilds the aggregate. Does NOT remove anything from the existing
// aggregate — adds only.
function doBackfill(argv) {
  const path = argv[0];
  if (!path) {
    fail('usage: claude-rpc backfill <path>',
      { hint: 'point at any folder containing .jsonl transcripts (e.g. a backup of ~/.claude/projects)' });
  }
  if (!existsSync(path)) {
    fail(`path doesn't exist: ${path}`,
      { hint: 'check the spelling, or run `claude-rpc doctor` to see where transcripts live' });
  }
  console.log(`${c.dim}Backfilling from${c.reset} ${c.cyan}${path}${c.reset}…`);
  const t0 = Date.now();
  let lastReport = 0;
  // Pass `extraDirs` rather than `projectsDirs` — this way the default
  // ~/.claude/projects (+ any auto-discovered alt paths) ALSO gets scanned
  // and the user's existing cache for those isn't pruned.
  const result = scan({
    force: false,
    extraDirs: [path],
    onProgress: ({ scanned, total }) => {
      if (Date.now() - lastReport > 500) {
        process.stdout.write(`\r  parsed ${scanned}/${total}…`);
        lastReport = Date.now();
      }
    },
  });
  process.stdout.write('\n');
  console.log(`${c.green}✓${c.reset} Done in ${Date.now() - t0}ms — ${c.cyan}${result.scanned}${c.reset} new/changed · ${result.skipped} cached`);
  console.log(`${c.dim}Scanned roots:${c.reset} ${result.dirs.join(', ')}`);
  const hours = ((result.aggregate.activeMs || 0) / 3_600_000).toFixed(1);
  console.log(`${c.dim}Aggregate now:${c.reset} ${result.aggregate.sessions} sessions · ${hours}h · ${result.aggregate.userMessages} prompts`);
}

function showInsights() {
  const aggregate = readAggregate();
  const insights = generateInsights(aggregate, { limit: 6 });
  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ Insights${c.reset}`);
  console.log('');
  for (const line of insights) console.log(`  ${c.dim}→${c.reset} ${line}`);
  console.log('');
}

function parseBadgeArgs(argv) {
  const out = { metric: 'hours', range: '7d', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--metric' || a === '-m') out.metric = argv[++i];
    else if (a === '--range' || a === '-r') out.range = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--label' || a === '-l') out.label = argv[++i];
  }
  return out;
}

function doBadge(argv) {
  const opts = parseBadgeArgs(argv);
  const aggregate = readAggregate();
  if (!aggregate) {
    fail('no aggregate yet — nothing to render', { hint: 'run `claude-rpc scan` first', code: EX_BAD_STATE });
  }
  const svg = badgeSvg({ aggregate, metric: opts.metric, range: opts.range, label: opts.label });
  if (opts.out) {
    writeFileSync(opts.out, svg);
    console.log(`${c.green}✓${c.reset} Wrote ${c.cyan}${opts.out}${c.reset} (${svg.length} bytes)`);
  } else {
    process.stdout.write(svg);
  }
}

// Poster-style SVG card. Bigger sibling of `badge` — shareable summary
// for a range (year / month / week / all-time). Output is SVG only;
// screenshot or convert to PNG offline if needed.
function parseCardArgs(argv) {
  const out = { range: 'year', out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--range' || a === '-r') out.range = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
  }
  return out;
}

async function doCard(argv) {
  const opts = parseCardArgs(argv);
  const aggregate = readAggregate();
  if (!aggregate) {
    fail('no aggregate yet — nothing to render', { hint: 'run `claude-rpc scan` first', code: EX_BAD_STATE });
  }
  const { renderCard } = await import('./card.js');
  const svg = renderCard(aggregate, { range: opts.range });
  if (opts.out) {
    writeFileSync(opts.out, svg);
    console.log(`${c.green}✓${c.reset} Wrote ${c.cyan}${opts.out}${c.reset} (${svg.length} bytes)`);
    console.log(`${c.dim}Tip: open in a browser, right-click → Save as PNG. Or drop straight into a Discord message — it'll render inline.${c.reset}`);
  } else {
    process.stdout.write(svg);
  }
}

// ── Privacy commands ─────────────────────────────────────────────────────
//
// `claude-rpc private`        → add current cwd to ~/.claude-rpc/private-list.json
// `claude-rpc public`         → remove current cwd
// `claude-rpc privacy`        → show resolved visibility for current cwd + listed paths
//
// Per-project overrides live in <project>/.claude-rpc.json and take priority
// over the runtime list. See src/privacy.js for the full resolution chain.

function doPrivate() {
  const cwd = process.cwd();
  const list = addPrivateCwd(cwd);
  console.log(`${c.green}✓${c.reset} ${c.cyan}${cwd}${c.reset} marked private`);
  console.log(`${c.dim}  ${list.length} ${list.length === 1 ? 'path' : 'paths'} in the private list. Daemon picks it up within ~5 min (cache TTL) or restart.${c.reset}`);
}

function doPublic() {
  const cwd = process.cwd();
  const before = listPrivateCwds().length;
  const list = removePrivateCwd(cwd);
  if (list.length === before) {
    console.log(`${c.yellow}!${c.reset} ${c.cyan}${cwd}${c.reset} wasn't in the private list`);
  } else {
    console.log(`${c.green}✓${c.reset} ${c.cyan}${cwd}${c.reset} removed from the private list`);
  }
}

function doPrivacy() {
  const cwd = process.cwd();
  const cfg = loadConfig();
  const { visibility, projectName, reason } = resolveVisibility(cwd, cfg);
  const color = visibility === 'hidden' ? c.red : visibility === 'name-only' ? c.yellow : c.green;
  console.log('');
  console.log(`  ${c.bold}privacy${c.reset}  ${c.dim}for${c.reset} ${c.cyan}${cwd}${c.reset}`);
  console.log(`    ${c.dim}visibility:${c.reset} ${color}${visibility}${c.reset}   ${c.dim}(${reason})${c.reset}`);
  if (projectName) console.log(`    ${c.dim}alias:    ${c.reset} ${projectName}`);
  const list = listPrivateCwds();
  if (list.length) {
    console.log('');
    console.log(`  ${c.bold}private-list${c.reset}  ${c.dim}(${list.length} ${list.length === 1 ? 'path' : 'paths'})${c.reset}`);
    for (const p of list) console.log(`    ${p === cwd ? c.cyan + '●' + c.reset : ' '} ${p}`);
  }
  console.log('');
  console.log(`  ${c.dim}toggle:   claude-rpc private  /  claude-rpc public${c.reset}`);
  console.log(`  ${c.dim}per-proj: drop a {"private": true} into .claude-rpc.json at the repo root${c.reset}`);
  console.log('');
}

function tailLog() {
  if (!existsSync(LOG_PATH)) {
    console.log(`${c.yellow}No log yet at ${LOG_PATH}${c.reset}`);
    return;
  }
  // Print the last ~30 lines, then follow.
  const raw = readFileSync(LOG_PATH, 'utf8').split('\n');
  const tail = raw.slice(-31, -1);
  for (const line of tail) process.stdout.write(line + '\n');
  let lastSize = readFileSync(LOG_PATH).length;
  console.log(`${c.dim}-- tailing ${LOG_PATH} (Ctrl-C to stop) --${c.reset}`);
  watchFile(LOG_PATH, { interval: 500 }, () => {
    try {
      const buf = readFileSync(LOG_PATH);
      if (buf.length > lastSize) {
        process.stdout.write(buf.slice(lastSize).toString('utf8'));
        lastSize = buf.length;
      } else if (buf.length < lastSize) {
        // file rotated
        lastSize = buf.length;
      }
    } catch {}
  });
}

// One-screen "where am I?" view. Goal: a user typing `claude-rpc` with no
// args sees in <24 lines what's happening and the four most useful next
// commands. Full command list lives behind --help.
function overview() {
  const setUp = hasUserConfig();
  const cfg = loadConfig();
  const pid = daemonPid();

  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ claude-rpc${c.reset}  ${c.dim}v${VERSION} — Discord Rich Presence for Claude Code${c.reset}`);
  console.log('');

  if (!setUp) {
    console.log(`  ${c.yellow}○${c.reset} not configured yet`);
    console.log('');
    console.log(`  Run ${c.cyan}claude-rpc setup${c.reset} to get started.`);
    console.log('');
    console.log(`  ${c.dim}--help for the full command list${c.reset}`);
    console.log('');
    return;
  }

  // Status line: daemon up/down + project + model + status verb.
  const state = readState();
  const aggregate = readAggregate();
  state.liveSessions = findLiveSessions({ thresholdMs: 90_000 });
  const vars = buildVars(state, cfg, aggregate);
  const dot = pid
    ? `${c.green}●${c.reset} running ${c.dim}pid ${pid}${c.reset}`
    : `${c.yellow}○${c.reset} ${c.dim}daemon not running${c.reset}`;
  if (pid) {
    console.log(`  ${dot}  ${c.gray}·${c.reset}  ${c.bold}${vars.modelPretty}${c.reset} in ${c.bold}${vars.project}${c.reset}  ${c.gray}·${c.reset}  ${statusColor(vars.status)}${vars.statusVerbose}${c.reset}`);
  } else {
    console.log(`  ${dot}`);
  }

  if (aggregate) {
    console.log('');
    console.log(`  ${c.dim}today  ${c.reset}${c.green}${vars.todayHours.padEnd(6)}${c.reset}${c.dim}active  ·  ${vars.todayPromptsLabel}  ·  ${vars.todayCostFmt}${c.reset}`);
    console.log(`  ${c.dim}streak ${c.reset}${c.magenta}${String(vars.streak).padEnd(6)}${c.reset}${c.dim}${vars.streak === 1 ? 'day' : 'days'}  ·  longest ${vars.longestStreak}  ·  ${vars.allHours} all-time${c.reset}`);
  } else {
    console.log('');
    console.log(`  ${c.dim}no stats yet — run ${c.reset}${c.cyan}claude-rpc scan${c.reset}${c.dim} to build aggregates${c.reset}`);
  }

  // Four most useful next commands. Doctor leads — it's the answer to
  // "something looks wrong" without the user having to read anything.
  console.log('');
  const next = pid
    ? [['status', 'full dashboard with heatmap'],
       ['doctor', 'diagnose problems'],
       ['serve',  'open the web dashboard'],
       ['stop',   'stop the daemon']]
    : (cfg.clientId && cfg.clientId !== '1234567890123456789')
      ? [['start',  'launch the daemon'],
         ['doctor', 'diagnose problems'],
         ['status', 'show current stats'],
         ['setup',  'register Claude Code hooks']]
      : [['setup',  'install hooks and seed config'],
         ['doctor', 'diagnose problems'],
         ['start',  'launch the daemon'],
         ['status', 'show current stats']];
  for (const [name, desc] of next) {
    console.log(`  ${c.cyan}${name.padEnd(8)}${c.reset}  ${c.dim}→${c.reset}  ${desc}`);
  }
  console.log('');
  console.log(`  ${c.dim}--help for the full command list  ·  --version${c.reset}`);
  console.log('');
}

function help() {
  const cmds = [
    ['setup',     'Install Claude Code hooks (~/.claude/settings.json)'],
    ['uninstall', 'Remove Claude Code hooks'],
    ['upgrade-config', 'Re-run idempotent migrations on an existing config.json'],
    ['start',     'Start the Discord RPC daemon (detached)'],
    ['stop',      'Stop the daemon'],
    ['restart',   'Stop then start the daemon'],
    ['status',    'Print current session + all-time stats'],
    ['today',     'Focus view: today\'s stats + 24h activity histogram'],
    ['week',      'Focus view: this week, daily breakdown'],
    ['serve',     'Open a live web dashboard in your browser'],
    ['preview',   'Show how each rotation frame renders right now'],
    ['scan',      'Incrementally scan ~/.claude/projects for all-time totals'],
    ['rescan',    'Force re-parse every transcript (ignores cache)'],
    ['backfill',  'Import transcripts from any folder (e.g. a backup)'],
    ['insights',  'Auto-generated insights from your history'],
    ['badge',     'Render a Shields-style SVG (--metric --range --out)'],
    ['card',      'Render a poster-style SVG summary (--range year|month|week|all)'],
    ['private',   'Mark the current directory as private (hide from Discord)'],
    ['public',    'Un-mark the current directory'],
    ['privacy',   'Show resolved visibility for the current directory'],
    ['doctor',    'Run a diagnostic checklist — common-failure triage'],
    ['tail',      'Tail the daemon log file'],
    ['daemon',    'Run daemon in foreground (debug)'],
  ];
  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ claude-rpc${c.reset}  ${c.dim}— Discord Rich Presence for Claude Code${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}Commands:${c.reset}`);
  for (const [name, desc] of cmds) {
    console.log(`    ${c.cyan}${name.padEnd(10)}${c.reset}  ${desc}`);
  }
  console.log('');
  console.log(`  ${c.dim}First-time setup:${c.reset}`);
  console.log(`    1. Set ${c.cyan}clientId${c.reset} in ${c.cyan}config.json${c.reset} to your Discord app id.`);
  console.log(`    2. (Optional) Upload art under Rich Presence → Art Assets: ${c.cyan}claude${c.reset}, ${c.cyan}working${c.reset}, ${c.cyan}idle${c.reset}, ${c.cyan}thinking${c.reset}.`);
  console.log(`    3. ${c.cyan}npm install${c.reset}  &&  ${c.cyan}claude-rpc setup${c.reset}  &&  ${c.cyan}claude-rpc start${c.reset}.`);
  console.log('');
  console.log(`  ${c.dim}Tip: ${c.reset}edit ${c.cyan}config.json${c.reset} to customize rotation frames. Run ${c.cyan}claude-rpc preview${c.reset} to see the result without Discord.`);
  console.log('');
  console.log(`  ${c.dim}Exit codes:${c.reset} ${c.dim}0 ok · 1 user error · 2 system error · 3 wrong state${c.reset}`);
  console.log('');
}

// Packaged exe: `claude-rpc.exe` with no args → first-run install + start.
// `claude-rpc.exe hook PreToolUse` → handle hook.
// Dev mode keeps the original `help` fallback so behavior is unchanged.
const packagedDefault = IS_PACKAGED && !cmd;

// Wrapped in an async IIFE so the same source compiles cleanly under both
// ESM (dev) and CommonJS (esbuild → SEA bundle) — CJS doesn't allow
// top-level await.
(async () => {
  switch (cmd) {
    case '--version':
    case '-V':
    case '-v':        console.log(`claude-rpc ${VERSION}`); break;
    case '--help':
    case '-h':
    case 'help':      help(); break;
    case 'setup':     await runInstall({ exePath: EXE_PATH || process.execPath, withStartup: false }); break;
    case 'install':   await runInstall({ exePath: EXE_PATH || process.execPath }); break;
    case 'uninstall': await runUninstall(); break;
    case 'upgrade-config': migrateConfig(); break;
    case 'start':     startDaemon(); break;
    case 'stop':      stopDaemon(); break;
    case 'restart':   restartDaemon(); break;
    case 'status': {
      const dumpFlag = process.argv.slice(3).some((a) => a === '--dump' || a === '-d');
      if (dumpFlag || !process.stdout.isTTY) showStatus();
      else startTui();
      break;
    }
    case 'dump':      showStatus(); break;
    case 'today':     showToday(); break;
    case 'week':      showWeek(); break;
    case 'serve':     await import('./server/index.js'); break;
    case 'preview':   showPreview(); break;
    case 'vars':      dumpVars(); break;
    case 'scan':      doScan(false); break;
    case 'rescan':    doScan(true); break;
    case 'backfill':  doBackfill(process.argv.slice(3)); break;
    case 'insights':  showInsights(); break;
    case 'badge':     doBadge(process.argv.slice(3)); break;
    case 'card':      await doCard(process.argv.slice(3)); break;
    case 'private':   doPrivate(); break;
    case 'public':    doPublic(); break;
    case 'privacy':   doPrivacy(); break;
    case 'doctor': {
      const { runDoctor } = await import('./doctor.js');
      process.exit(runDoctor());
      break;
    }
    case 'tail':
    case 'logs':
    case 'log':       tailLog(); break;
    case 'hook':      runHookCli(process.argv[3] || 'unknown'); break;
    case 'daemon':    await import('./daemon.js'); break;
    default: {
      if (packagedDefault) {
        if (!isInstalled()) {
          await runInstall({ exePath: EXE_PATH || process.execPath });
          startDaemon();
        } else {
          // Self-heal an existing install. Two real failure modes this fixes:
          //
          //  1. Hook entries in ~/.claude/settings.json can still point at
          //     the user's original launch directory (e.g. ~/Downloads).
          //     If that exe is gone or out-of-date, SessionEnd never reaches
          //     the *current* daemon — close detection silently breaks.
          //
          //  2. state.json can be pinned at status='idle' from a long-ago
          //     session. applyIdle treats idle as the resting state and
          //     won't transition out of it until the next hook fires; with
          //     hooks broken (see #1) the daemon happily renders idle-with-
          //     real-aggregate-data forever.
          //
          // Refresh hooks against the canonical exe, migrate config blocks,
          // wipe state, restart daemon. Anything the user has customized in
          // config.json is preserved (migrateConfig is non-destructive).
          console.log('Claude RPC is installed. Refreshing…');
          try {
            const target = ensureCanonicalExe(process.execPath);
            migrateConfig();
            installHooks(target);
          } catch (e) {
            console.warn(`refresh skipped: ${e.message}`);
          }
          const wasRunning = stopDaemon({ quiet: true });
          try { if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH); } catch {}
          if (wasRunning) {
            // Brief wait for the OS to release the pid file before we spawn.
            setTimeout(() => startDaemon(), 700);
          } else {
            startDaemon();
          }
        }
      } else if (!cmd) {
        // True no-args invocation in dev/npm mode → one-screen overview.
        // The packagedDefault branch above handles the SEA exe's "double-
        // click with no args" install-and-start flow.
        overview();
      } else {
        fail(`unknown command: ${cmd}`,
          { hint: 'run `claude-rpc --help` for the full list', code: EX_USER_ERROR });
      }
    }
  }
})();
