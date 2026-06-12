#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, watchFile, unlinkSync } from 'node:fs';
import process from 'node:process';

// Force the console code page to UTF-8 (65001) on Windows so Unicode box
// drawing, block elements, and other chars render correctly. Default cmd.exe
// code page on Win10 is 437/850, which displays many of our chars as `?`.
// Hook events (no TTY) skip this — they don't print anything user-visible.
if (process.platform === 'win32' && process.stdout.isTTY) {
  try { spawnSync('chcp.com', ['65001'], { stdio: 'ignore', windowsHide: true }); } catch { /* chcp absent (Wine, custom shell) — accept whatever code page is set */ }
}
import { DAEMON_SCRIPT, PID_PATH, STATE_PATH, LOG_PATH, AGGREGATE_PATH, CONFIG_PATH, IS_PACKAGED, IS_NPX, EXE_PATH, CANONICAL_EXE } from './paths.js';
import { readState } from './state.js';
import { buildVars, fillTemplate, humanProject, humanTool, applyIdle, framePasses, fmtNum } from './format.js';
import { scan, readAggregate, findLiveSessions, dayKey, weekKey } from './scanner.js';
import { runHookCli } from './hook.js';
import { install as runInstall, uninstall as runUninstall, isInstalled, migrateConfig, installHooks, ensureCanonicalExe, installMcp, uninstallMcp, mcpServerCommand, setupOutro } from './install.js';
import { startTui } from './tui.js';
import { generateInsights } from './insights.js';
import { maybeNudge } from './nudge.js';
import { badgeSvg } from './badge.js';
import { fmtCost } from './pricing.js';
import { addPrivateCwd, removePrivateCwd, listPrivateCwds, resolveVisibility } from './privacy.js';
import { parseDuration, setPause, clearPause, pauseUntil } from './pause.js';
import { loadConfig, hasUserConfig } from './config.js';
import * as lb from './leaderboard.js';
import { VERSION } from './version.js';
import { fail, tailLines, EX_USER_ERROR, EX_BAD_STATE, EX_SYS_ERROR } from './ui.js';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
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
    if (!quiet) console.log(`  ${c.yellow}!${c.reset}  ${'daemon running'.padEnd(16)}${c.dim}already up (pid ${pid}) · bounce it with ${c.reset}${c.cyan}claude-rpc restart${c.reset}`);
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
  if (!quiet) console.log(`  ${c.green}✓${c.reset}  ${'daemon launched'.padEnd(16)}${c.dim}pid ${c.reset}${c.cyan}${child.pid}${c.reset}${c.dim} · log ${shortPath(LOG_PATH)}${c.reset}`);
  return true;
}

function stopDaemon({ quiet = false } = {}) {
  const pid = daemonPid();
  if (!pid) { if (!quiet) console.log(`  ${c.cyan}·${c.reset}  daemon not running`); return false; }
  try {
    process.kill(pid, 'SIGTERM');
    if (!quiet) console.log(`  ${c.green}✓${c.reset}  ${'daemon stopping'.padEnd(16)}${c.dim}sent SIGTERM to pid ${pid}${c.reset}`);
    return true;
  } catch (e) {
    if (!quiet) console.log(`  ${c.red}✗${c.reset}  ${'stop failed'.padEnd(16)}${c.dim}${e.message}${c.reset}`);
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
  const top    = `${c.gray}┌─ ${c.reset}${c.bold}${title}${c.reset} ${c.gray}${'─'.repeat(Math.max(0, width - 5 - title.length))}┐${c.reset}`;
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

  // Share nudge — only on a TTY (keeps piped/scripted output clean) and only
  // when a new milestone was crossed. maybeNudge marks it shown internally.
  if (process.stdout.isTTY) {
    const nudge = maybeNudge(aggregate, config);
    if (nudge) console.log(`  ${c.dim}↗ share${c.reset}  ${nudge}\n`);
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
  console.log(`  ${c.dim}scanning ~/.claude/projects ${force ? '(force re-parse)' : '(incremental)'}…${c.reset}`);
  const t0 = Date.now();
  let lastReport = 0;
  const result = scan({
    force,
    onProgress: ({ scanned, total }) => {
      if (Date.now() - lastReport > 500) {
        process.stdout.write(`\r  ${c.dim}parsed ${scanned}/${total}…${c.reset}`);
        lastReport = Date.now();
      }
    },
  });
  process.stdout.write('\n');
  console.log(`  ${c.green}✓${c.reset}  scan complete  ${c.dim}${Date.now() - t0}ms — ${c.reset}${c.cyan}${result.scanned}${c.reset}${c.dim} parsed · ${result.skipped} cached · ${result.removed} removed (${result.total} total)${c.reset}`);
  if (result.dirs && result.dirs.length > 1) {
    console.log(`     ${c.dim}roots: ${result.dirs.join(', ')}${c.reset}`);
  }
  console.log(`     ${c.dim}aggregate → ${AGGREGATE_PATH}${c.reset}`);
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
      { hint: 'check the spelling — relative paths resolve from the current directory' });
  }
  console.log(`  ${c.dim}backfilling from ${c.reset}${c.cyan}${path}${c.reset}${c.dim}…${c.reset}`);
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
        process.stdout.write(`\r  ${c.dim}parsed ${scanned}/${total}…${c.reset}`);
        lastReport = Date.now();
      }
    },
  });
  process.stdout.write('\n');
  console.log(`  ${c.green}✓${c.reset}  backfill complete  ${c.dim}${Date.now() - t0}ms — ${c.reset}${c.cyan}${result.scanned}${c.reset}${c.dim} new/changed · ${result.skipped} cached${c.reset}`);
  console.log(`     ${c.dim}roots: ${result.dirs.join(', ')}${c.reset}`);
  const hours = ((result.aggregate.activeMs || 0) / 3_600_000).toFixed(1);
  console.log(`     ${c.dim}aggregate now: ${result.aggregate.sessions} sessions · ${hours}h · ${result.aggregate.userMessages} prompts${c.reset}`);
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
  const out = { metric: 'hours', range: '7d', out: '', gist: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--metric' || a === '-m') out.metric = argv[++i];
    else if (a === '--range' || a === '-r') out.range = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--label' || a === '-l') out.label = argv[++i];
    else if (a === '--gist') out.gist = true;
  }
  return out;
}

async function doBadge(argv) {
  const opts = parseBadgeArgs(argv);
  const aggregate = readAggregate();
  if (!aggregate) {
    fail('no aggregate yet — nothing to render', { hint: 'run `claude-rpc scan` first', code: EX_BAD_STATE });
  }
  const svg = badgeSvg({ aggregate, metric: opts.metric, range: opts.range, label: opts.label });
  if (opts.gist) {
    await publishBadgeToGist(svg, opts);
    return;
  }
  if (opts.out) {
    writeFileSync(opts.out, svg);
    console.log(`  ${c.green}✓${c.reset}  wrote ${c.cyan}${opts.out}${c.reset}  ${c.dim}(${svg.length} bytes)${c.reset}`);
  } else {
    process.stdout.write(svg);
  }
}

// Publish the rendered badge to a GitHub gist and emit the README-ready
// markdown snippet. First successful publish records id+owner in
// config.json so subsequent runs UPDATE that gist (raw URL stays stable).
async function publishBadgeToGist(svg, opts) {
  const { publishGistFile, gistMarkdown } = await import('./gist.js');
  const cfg = loadConfig();
  const stored = cfg.gist || {};
  const filename = stored.filename || 'claude.svg';
  try {
    const result = await publishGistFile({
      svg,
      filename,
      description: `claude-rpc — ${opts.metric || 'hours'} (${opts.range || '7d'})`,
      gistId: stored.id || undefined,
      owner: stored.owner || undefined,
      isPublic: stored.public !== false,
    });
    // Persist the resolved id+owner so the next `--gist` run does an EDIT.
    // We merge into the user's config.json directly (not the merged-defaults)
    // so the file stays minimal.
    const userCfg = readJson(CONFIG_PATH, {});
    userCfg.gist = {
      ...(userCfg.gist || {}),
      id: result.id,
      owner: result.owner,
      filename,
    };
    if (stored.public !== undefined) userCfg.gist.public = stored.public;
    writeFileSync(CONFIG_PATH, JSON.stringify(userCfg, null, 2));
    const wasUpdate = !!stored.id;
    console.log('');
    console.log(`  ${c.green}✓${c.reset}  ${wasUpdate ? 'updated' : 'created'} gist ${c.cyan}${result.id}${c.reset}`);
    console.log(`     ${c.dim}raw: ${c.reset}${c.cyan}${result.rawUrl}${c.reset}`);
    if (result.htmlUrl) console.log(`     ${c.dim}gist: ${result.htmlUrl}${c.reset}`);
    console.log('');
    console.log(`  ${c.dim}paste into your README:${c.reset}`);
    console.log(`    ${gistMarkdown({ owner: result.owner, id: result.id, filename, label: 'Claude' })}`);
    console.log('');
  } catch (e) {
    fail(`gist publish failed: ${e.message}`, {
      hint: 'install gh (`gh auth login`) or set GH_TOKEN with `gist` scope',
      code: EX_USER_ERROR,
    });
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
    console.log(`  ${c.green}✓${c.reset}  wrote ${c.cyan}${opts.out}${c.reset}  ${c.dim}(${svg.length} bytes)${c.reset}`);
    console.log(`     ${c.dim}tip: open in a browser and save as PNG — or drop it straight into a Discord message; it renders inline${c.reset}`);
  } else {
    process.stdout.write(svg);
  }
}

// GitHub profile stat card — a compact, embeddable lifetime summary meant
// for a profile README. `--gist` publishes it to a gist (raw URL stays stable
// across re-runs) so the README image auto-refreshes when you re-run it.
function parseGithubStatArgs(argv) {
  const out = { out: '', gist: false, handle: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--handle' || a === '-u') out.handle = argv[++i];
    else if (a === '--gist') out.gist = true;
  }
  return out;
}

async function doGithubStat(argv) {
  const opts = parseGithubStatArgs(argv);
  const aggregate = readAggregate();
  if (!aggregate) {
    fail('no aggregate yet — nothing to render', { hint: 'run `claude-rpc scan` first', code: EX_BAD_STATE });
  }
  const { renderProfileCard } = await import('./profile.js');
  const svg = renderProfileCard(aggregate, { handle: opts.handle });
  if (opts.gist) {
    await publishBadgeToGist(svg, { metric: 'profile', range: 'all-time' });
    return;
  }
  if (opts.out) {
    writeFileSync(opts.out, svg);
    console.log(`  ${c.green}✓${c.reset}  wrote ${c.cyan}${opts.out}${c.reset}  ${c.dim}(${svg.length} bytes)${c.reset}`);
    console.log(`     ${c.dim}embed in your README:  <img src="${opts.out}" alt="Claude Code stats" width="500" />${c.reset}`);
  } else {
    process.stdout.write(svg);
  }
}

// Build the live template-variable table the way the daemon does — current
// state + idle/stale resolution + aggregate. Shared by statusline/session-card.
function liveVars() {
  const state = readState();
  state.liveSessions = findLiveSessions({ thresholdMs: 90_000 });
  const config = loadConfig();
  const resolved = applyIdle(state, config);
  return { vars: buildVars(resolved, config, readAggregate()), config };
}

// statusline — a compact one-line status for tmux / starship / shell prompts
// and Claude Code's own statusline. `--template "..."` overrides the format.
function doStatusline(argv) {
  let tpl = '{statusVerbose} · {project} · {modelPretty}{tokensLabelPad}';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--template' || argv[i] === '-t') tpl = argv[++i] || tpl;
  }
  const { vars } = liveVars();
  vars.tokensLabelPad = vars.tokensLabel ? ` · ${vars.tokensLabel}` : '';
  process.stdout.write(fillTemplate(tpl, vars));
}

// Activity calendar — GitHub-contributions-style year heatmap SVG.
async function doCalendar(argv) {
  const opts = { out: '', gist: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' || argv[i] === '-o') opts.out = argv[++i];
    else if (argv[i] === '--gist') opts.gist = true;
  }
  const aggregate = readAggregate();
  if (!aggregate) fail('no aggregate yet — nothing to render', { hint: 'run `claude-rpc scan` first', code: EX_BAD_STATE });
  const { renderCalendar } = await import('./calendar.js');
  const svg = renderCalendar(aggregate, {});
  if (opts.gist) return publishBadgeToGist(svg, { metric: 'calendar', range: 'year' });
  if (opts.out) {
    writeFileSync(opts.out, svg);
    console.log(`  ${c.green}✓${c.reset}  wrote ${c.cyan}${opts.out}${c.reset}  ${c.dim}(${svg.length} bytes)${c.reset}`);
  } else process.stdout.write(svg);
}

// Per-session recap card — current/most-recent session as a shareable SVG.
async function doSessionCard(argv) {
  const opts = { out: '' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' || argv[i] === '-o') opts.out = argv[++i];
  }
  const { vars } = liveVars();
  const { renderSessionCard } = await import('./session-card.js');
  const svg = renderSessionCard(vars, {});
  if (opts.out) {
    writeFileSync(opts.out, svg);
    console.log(`  ${c.green}✓${c.reset}  wrote ${c.cyan}${opts.out}${c.reset}  ${c.dim}(${svg.length} bytes)${c.reset}`);
  } else process.stdout.write(svg);
}

// MCP server — expose stats to Claude Code over stdio. Long-running; never
// writes to stdout except JSON-RPC frames.
async function doMcp() {
  const { runMcpServer } = await import('./mcp.js');
  runMcpServer();
}

// One-command wiring into Claude Code — runs `claude mcp add` for the user.
function doMcpInstall(argv) {
  const scope = argv.includes('--project') ? 'project' : argv.includes('--local') ? 'local' : 'user';
  const res = installMcp({ exePath: EXE_PATH || process.execPath, scope });
  const manual = (r) => `claude mcp add claude-rpc --scope ${scope} -- ${r.command} ${r.args.join(' ')}`;
  if (res.ok) {
    console.log('');
    console.log(`  ${c.green}✓${c.reset}  registered the ${c.cyan}claude-rpc${c.reset} MCP server with Claude Code ${c.dim}(scope: ${scope})${c.reset}`);
    console.log(`     ${c.dim}restart Claude Code (or run /mcp), then ask: "how long have I coded today?"${c.reset}`);
    console.log('');
  } else if (res.reason === 'no-claude') {
    fail('the `claude` CLI was not found on your PATH', {
      hint: `install Claude Code first, then run: ${manual(res)}`,
      code: EX_USER_ERROR,
    });
  } else {
    fail(`\`claude mcp add\` failed (exit ${res.code})`, { hint: `try it manually: ${manual(res)}`, code: EX_USER_ERROR });
  }
}

function doMcpUninstall(argv) {
  const scope = argv.includes('--project') ? 'project' : argv.includes('--local') ? 'local' : 'user';
  const res = uninstallMcp({ scope });
  if (res.ok) console.log(`  ${c.green}✓${c.reset}  removed the claude-rpc MCP server ${c.dim}(scope: ${scope})${c.reset}`);
  else if (res.reason === 'no-claude') fail('the `claude` CLI was not found on your PATH', { code: EX_USER_ERROR });
  else fail('could not remove the MCP server', { hint: 'claude mcp remove claude-rpc', code: EX_USER_ERROR });
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
  console.log(`  ${c.green}✓${c.reset}  ${c.cyan}${cwd}${c.reset} marked private`);
  console.log(`     ${c.dim}${list.length} ${list.length === 1 ? 'path' : 'paths'} in the private list — the daemon picks it up within ~5 min, or ${c.reset}${c.cyan}claude-rpc restart${c.reset}`);
}

function doPublic() {
  const cwd = process.cwd();
  const before = listPrivateCwds().length;
  const list = removePrivateCwd(cwd);
  if (list.length === before) {
    console.log(`  ${c.yellow}!${c.reset}  ${c.cyan}${cwd}${c.reset} wasn't in the private list`);
  } else {
    console.log(`  ${c.green}✓${c.reset}  ${c.cyan}${cwd}${c.reset} removed from the private list`);
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

// ── Pause / resume ───────────────────────────────────────────────────────
//
// `claude-rpc pause [30m|2h|1h30m|90]` → snooze the Discord card globally
// (default 1h). `claude-rpc resume` (or `pause off`) lifts it early; expiry
// lifts it automatically. Privacy controls are per-cwd — this is the
// "I'm screen-sharing" switch that hides everything regardless of project.

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function doPause(argv) {
  const arg = (argv[0] || '').toLowerCase();
  if (arg === 'off' || arg === 'resume') return doResume();
  if (arg === 'status') {
    const until = pauseUntil();
    if (until) console.log(`  ${c.yellow}●${c.reset}  paused until ${c.cyan}${fmtClock(until)}${c.reset}`);
    else console.log(`  ${c.green}○${c.reset}  not paused`);
    return;
  }
  const ms = parseDuration(argv[0]);
  if (ms === null) {
    fail(`could not parse duration: ${argv[0]}`,
      { hint: 'use 30m, 2h, 1h30m, or a bare number of minutes (default: 1h)', code: EX_USER_ERROR });
  }
  const until = setPause(ms);
  console.log(`  ${c.green}✓${c.reset}  presence paused until ${c.cyan}${fmtClock(until)}${c.reset}`);
  console.log(`     ${c.dim}the daemon clears the card within seconds — resume early with ${c.reset}${c.cyan}claude-rpc resume${c.reset}`);
}

function doResume() {
  const was = pauseUntil();
  clearPause();
  if (was) {
    console.log(`  ${c.green}✓${c.reset}  presence resumed ${c.dim}(was paused until ${fmtClock(was)})${c.reset}`);
  } else {
    console.log(`  ${c.cyan}·${c.reset}  presence wasn't paused`);
  }
}

// ── Export ───────────────────────────────────────────────────────────────
//
// `claude-rpc export [--csv] [--out <file>]` — the full aggregate as JSON, or
// the per-day breakdown as CSV (same shape the dashboard's /api/export routes
// serve, without needing the server up). Writes to stdout unless --out, so it
// pipes cleanly into jq / a spreadsheet import.

async function doExport(argv) {
  const csv = argv.includes('--csv');
  let out = '';
  const i = argv.findIndex((a) => a === '--out' || a === '-o');
  if (i !== -1) out = argv[i + 1] || '';
  const aggregate = readAggregate();
  if (!aggregate) {
    fail('no aggregate yet — nothing to export', { hint: 'run `claude-rpc scan` first', code: EX_BAD_STATE });
  }
  let payload;
  if (csv) {
    const { aggregateToCsv } = await import('./server/api.js');
    payload = aggregateToCsv(aggregate);
  } else {
    payload = JSON.stringify(aggregate, null, 2) + '\n';
  }
  if (out) {
    writeFileSync(out, payload);
    console.log(`  ${c.green}✓${c.reset}  wrote ${c.cyan}${out}${c.reset}  ${c.dim}(${payload.length} bytes, ${csv ? 'CSV' : 'JSON'})${c.reset}`);
  } else {
    process.stdout.write(payload);
  }
}

// ── Squads — private mini-leaderboards (terminal parity for the web UI) ───
//
// `claude-rpc squad create <name>` → invite code + link
// `claude-rpc squad join <code>`
// `claude-rpc squad` / `squad status`  → standings for every squad you're in
// `claude-rpc squad leave [id]`
// The web flow (claude-rpc.vercel.app + GitHub login) drives the same worker
// endpoints; the CLI authenticates with the community instanceId it already has.

function squadAuth() {
  const cfg = loadConfig();
  const endpoint = (cfg.community?.endpoint || '').replace(/\/+$/, '');
  const instanceId = cfg.community?.instanceId;
  if (!endpoint) {
    fail('no community endpoint configured', {
      hint: 'config.json is missing community.endpoint — re-run `claude-rpc setup` to restore the default',
      code: EX_BAD_STATE,
    });
  }
  if (!instanceId) {
    fail('squads need an identity', {
      hint: 'run `claude-rpc profile set --handle <name> && claude-rpc profile on` first',
      code: EX_BAD_STATE,
    });
  }
  const post = async (path, body) => {
    const res = await fetch(endpoint + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceId, ...body }),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const get = async (path) => {
    const res = await fetch(endpoint + path);
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  return { cfg, endpoint, instanceId, post, get };
}

function squadPageUrl(id) { return `https://claude-rpc.vercel.app/squad/${id}`; }

function printSquadInvite(squad) {
  console.log('');
  console.log(`  ${c.green}✓${c.reset}  squad ${c.bold}${squad.name}${c.reset}`);
  console.log(`     ${c.dim}invite code:${c.reset} ${c.cyan}${squad.code}${c.reset}`);
  console.log(`     ${c.dim}standings:  ${c.reset} ${c.cyan}${squadPageUrl(squad.id)}${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}send your crew this:${c.reset}`);
  console.log(`    join my Claude Code squad "${squad.name}" — npx claude-rpc@latest setup, then:`);
  console.log(`    ${c.cyan}claude-rpc squad join ${squad.code}${c.reset}  ${c.dim}(or join in the browser: ${squadPageUrl(squad.id)})${c.reset}`);
  console.log('');
}

async function squadStatus({ post, get }) {
  const mine = await post('/squads/mine', {});
  if (!mine.json?.squads) return fail(`could not load squads: ${mine.json?.error || mine.status}`, { code: EX_SYS_ERROR });
  if (!mine.json.squads.length) {
    console.log('');
    console.log(`  ${c.dim}no squads yet — start one:${c.reset} ${c.cyan}claude-rpc squad create "the night shift"${c.reset}`);
    console.log('');
    return;
  }
  for (const s of mine.json.squads) {
    const r = await get(`/squad?id=${encodeURIComponent(s.id)}`);
    const standings = r.json?.standings || [];
    const lines = standings.map((row) => {
      const who = `${row.displayName || '@' + row.handle}${row.verified ? ' ✓' : ''}${row.owner ? ` ${c.dim}(owner)${c.reset}` : ''}`;
      return `${c.bold}#${row.rank}${c.reset} ${who.padEnd(28)} ${c.cyan}${fmtNum(row.weekTokens)}${c.reset} ${c.dim}this week${c.reset} · ${fmtNum(row.tokens)} ${c.dim}lifetime${c.reset}`;
    });
    lines.push('');
    lines.push(`${c.dim}week ${r.json?.squad?.week || ''} · invite ${c.reset}${c.cyan}${s.code}${c.reset}${c.dim} · ${squadPageUrl(s.id)}${c.reset}`);
    box(`${s.name} (${s.members})`, lines, 70);
    console.log('');
  }
}

async function doSquadCmd(argv) {
  const sub = (argv[0] || 'status').toLowerCase();
  const ctx = squadAuth();
  if (sub === 'status' || sub === '') return squadStatus(ctx);
  if (sub === 'create') {
    const name = argv.slice(1).join(' ').trim();
    if (!name) {
      return fail('usage: claude-rpc squad create <name>',
        { hint: 'example: claude-rpc squad create "the night shift"', code: EX_USER_ERROR });
    }
    const r = await ctx.post('/squad/create', { name });
    if (r.status !== 200) return fail(`create failed: ${r.json?.error || r.status}`, { code: EX_SYS_ERROR });
    return printSquadInvite(r.json.squad);
  }
  if (sub === 'join') {
    const code = (argv[1] || '').trim();
    if (!code) {
      return fail('usage: claude-rpc squad join SQ-XXXXXX',
        { hint: 'the invite code comes from whoever created the squad (`claude-rpc squad create`)', code: EX_USER_ERROR });
    }
    const r = await ctx.post('/squad/join', { code });
    if (r.status !== 200) {
      return fail(`join failed: ${r.json?.error || r.status}`,
        { hint: 'double-check the invite code with whoever created the squad', code: EX_SYS_ERROR });
    }
    const s = r.json.squad;
    console.log(`  ${c.green}✓${c.reset}  ${s.alreadyMember ? 'already in' : 'joined'} ${c.bold}${s.name}${c.reset} ${c.dim}(${s.members} member${s.members === 1 ? '' : 's'})${c.reset}`);
    console.log(`     ${c.dim}standings: ${squadPageUrl(s.id)} — or run ${c.reset}${c.cyan}claude-rpc squad${c.reset}`);
    return;
  }
  if (sub === 'leave') {
    const mine = await ctx.post('/squads/mine', {});
    const squads = mine.json?.squads || [];
    if (!squads.length) return fail('you are not in any squads', { code: EX_BAD_STATE });
    let target = null;
    const wanted = (argv[1] || '').toLowerCase();
    if (wanted) target = squads.find((s) => s.id === wanted || s.name.toLowerCase() === wanted);
    else if (squads.length === 1) target = squads[0];
    if (!target) {
      return fail(squads.length > 1 && !wanted ? 'you are in several squads — name one' : `no squad matching "${argv[1]}"`, {
        hint: `claude-rpc squad leave <id|name> — yours: ${squads.map((s) => `${s.name} (${s.id})`).join(', ')}`,
        code: EX_USER_ERROR,
      });
    }
    const r = await ctx.post('/squad/leave', { squadId: target.id });
    if (r.status !== 200) return fail(`leave failed: ${r.json?.error || r.status}`, { code: EX_SYS_ERROR });
    console.log(`  ${c.green}✓${c.reset}  left ${c.bold}${target.name}${c.reset}${r.json.dissolved ? ` ${c.dim}(last member — squad dissolved)${c.reset}` : ''}`);
    return;
  }
  fail(`unknown squad subcommand: ${sub}`, {
    hint: 'try: squad [status|create <name>|join <code>|leave [id]]',
    code: EX_USER_ERROR,
  });
}

// ── Link (one profile across machines) ───────────────────────────────────
//
// Two-sided by design — one verb owns the whole story:
//   claude-rpc link            on your MAIN (verified) machine → mints a
//                              one-time code, no browser needed
//   claude-rpc link <code>     on the NEW machine → claims it, merging this
//                              install into the same leaderboard identity
// The browser fallback lives at claude-rpc.vercel.app/link (log in with
// GitHub → same code) for when the other machine isn't handy. Claiming
// verifies the profile (✓) and unlocks managing squads from the browser.

const LINK_PAGE = 'https://claude-rpc.vercel.app/link';

// Mint side: this machine asks the worker for a code. The worker only obliges
// when this install's canonical profile is verified — the ✓ a claim grants
// has to root in an already-proven identity.
async function linkMint(ctx) {
  const r = await ctx.post('/pair/start', {});
  if (r.status === 403) {
    return fail('link codes come from a verified machine — this one isn\'t yet', {
      hint: `verify here first (claude-rpc profile verify), or mint in the browser: ${LINK_PAGE}`,
      code: EX_BAD_STATE,
    });
  }
  if (r.status !== 200 || !r.json?.code) {
    return fail(`could not mint a link code: ${r.json?.error || r.status}`, { code: EX_SYS_ERROR });
  }
  const mins = Math.round((r.json.expiresInSec || 600) / 60);
  console.log('');
  console.log(`  ${c.green}✓${c.reset}  link code: ${c.cyan}${c.bold}${r.json.code}${c.reset}   ${c.dim}(expires in ${mins} min)${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}on the new machine:${c.reset}`);
  console.log(`    npx claude-rpc@latest setup`);
  console.log(`    ${c.cyan}claude-rpc link ${r.json.code}${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}one leaderboard profile — stats from every linked machine count as one${c.reset}`);
  console.log('');
}

async function doLink(argv) {
  const ctx = squadAuth();
  const code = (argv[0] || '').trim();
  if (!code) return linkMint(ctx);
  // Make sure the profile row exists server-side before claiming — same
  // pre-publish profileVerify does, so link works on a fresh `profile on`.
  if (lb.profileIsPublishable(ctx.cfg.profile || {})) {
    const { flushProfile } = await import('./community.js');
    await flushProfile(ctx.cfg);
  }
  const r = await ctx.post('/pair/claim', { code });
  if (r.status !== 200) {
    return fail(`link failed: ${r.json?.error || r.status}`,
      { hint: `get a fresh code: run \`claude-rpc link\` on your main machine, or ${LINK_PAGE}`, code: EX_SYS_ERROR });
  }
  // Mirror the verified identity locally so `profile status` agrees.
  const userCfg = readJson(CONFIG_PATH, {});
  userCfg.profile = { ...(userCfg.profile || {}), githubUser: r.json.githubUser, verified: true };
  writeFileSync(CONFIG_PATH, JSON.stringify(userCfg, null, 2));
  console.log(`  ${c.green}✓${c.reset}  linked as ${c.cyan}@${r.json.githubUser}${c.reset} — profile verified, squads unlocked in the browser`);
  if (r.json.merged) {
    // This machine joined an existing identity: its stats now roll up under the
    // canonical handle, one board row across all your machines.
    console.log(`  ${c.green}✓${c.reset}  this machine now merges into ${c.cyan}@${r.json.handle}${c.reset} ${c.dim}— stats from all your machines count as one${c.reset}`);
  }
  console.log(`     ${c.dim}started in a browser tab? it picks the link up automatically${c.reset}`);
}

// ── Community totals ─────────────────────────────────────────────────────
//
// `claude-rpc community`         → show current state + endpoint
// `claude-rpc community on`      → interactive consent flow, mint instanceId
//                                  (used by pre-v0.7 upgraders; fresh installs
//                                   already had setup mint the id)
// `claude-rpc community off`     → flip the flag off; instanceId retained
// `claude-rpc community report`  → one-shot manual flush (useful for testing)
//
// See src/community.js for the payload schema and worker/src/index.js
// for the receiving end. As of v0.7 this is on by default for fresh
// installs and preserved-off for pre-v0.7 upgraders (see migrateConfig).

function prompt(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function communityStatus() {
  const cfg = loadConfig();
  const community = cfg.community || {};
  const on = !!community.enabled;
  console.log('');
  console.log(`  ${c.bold}community totals${c.reset}`);
  console.log(`    ${c.dim}state:    ${c.reset} ${on ? c.green + 'on' + c.reset : c.yellow + 'off' + c.reset}`);
  console.log(`    ${c.dim}endpoint: ${c.reset} ${community.endpoint || '(unset)'}`);
  if (community.instanceId) {
    console.log(`    ${c.dim}id:       ${c.reset} ${c.dim}…${community.instanceId.slice(-8)}${c.reset}`);
  }
  console.log('');
  if (!on) {
    console.log(`  ${c.dim}enable with ${c.reset}${c.cyan}claude-rpc community on${c.reset}`);
  } else {
    console.log(`  ${c.dim}disable with ${c.reset}${c.cyan}claude-rpc community off${c.reset}`);
  }
  console.log('');
}

async function communityOn() {
  const cfg = loadConfig();
  const community = cfg.community || {};
  if (community.enabled) {
    console.log(`  ${c.green}✓${c.reset}  community totals are already enabled`);
    return;
  }
  console.log('');
  console.log(`  ${c.bold}claude-rpc community totals${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}What gets sent (and only this):${c.reset}`);
  console.log(`    ${c.green}·${c.reset} sessions delta since the last report`);
  console.log(`    ${c.green}·${c.reset} tokens   delta since the last report`);
  console.log(`    ${c.green}·${c.reset} claude-rpc version (${c.cyan}${VERSION}${c.reset})`);
  console.log(`    ${c.green}·${c.reset} OS family (${c.cyan}${process.platform}${c.reset})`);
  console.log(`    ${c.green}·${c.reset} anonymous instanceId (a fresh UUID v4)`);
  console.log('');
  console.log(`  ${c.dim}What never leaves your machine:${c.reset}`);
  console.log(`    ${c.red}·${c.reset} prompts, file paths, models, repos, costs`);
  console.log(`    ${c.red}·${c.reset} usernames, hostnames, IPs (the worker stores none)`);
  console.log('');
  console.log(`  ${c.dim}Endpoint:${c.reset} ${community.endpoint}`);
  console.log(`  ${c.dim}Source:  ${c.reset} ${c.cyan}worker/src/index.js${c.reset} in the claude-rpc repo`);
  console.log('');
  const answer = (await prompt(`  Enable? ${c.dim}[y/N]${c.reset} `)).trim();
  if (!/^y(es)?$/i.test(answer)) {
    console.log('');
    console.log(`  ${c.dim}cancelled.${c.reset}`);
    console.log('');
    return;
  }
  const userCfg = readJson(CONFIG_PATH, {});
  const next = {
    ...(userCfg.community || {}),
    enabled: true,
    instanceId: userCfg.community?.instanceId || community.instanceId || randomUUID(),
  };
  userCfg.community = next;
  writeFileSync(CONFIG_PATH, JSON.stringify(userCfg, null, 2));
  console.log('');
  console.log(`  ${c.green}✓${c.reset} community totals enabled`);
  console.log(`    ${c.dim}id: …${next.instanceId.slice(-8)}${c.reset}`);
  console.log(`    ${c.dim}the daemon flushes every ${community.flushIntervalMin || 30} min${c.reset}`);
  console.log('');
}

function communityOff() {
  const userCfg = readJson(CONFIG_PATH, {});
  if (!userCfg.community?.enabled) {
    console.log(`  ${c.cyan}·${c.reset}  community totals are already off`);
    return;
  }
  userCfg.community = { ...userCfg.community, enabled: false };
  writeFileSync(CONFIG_PATH, JSON.stringify(userCfg, null, 2));
  console.log(`  ${c.green}✓${c.reset}  community totals disabled ${c.dim}(instanceId retained for re-enable continuity)${c.reset}`);
}

async function communityReport() {
  const cfg = loadConfig();
  if (!cfg.community?.enabled) {
    fail('community totals are off', { hint: 'run `claude-rpc community on` first', code: EX_BAD_STATE });
  }
  const { flushCommunity } = await import('./community.js');
  const result = await flushCommunity(cfg);
  console.log('');
  if (result.ok && result.delta) {
    console.log(`  ${c.green}✓${c.reset}  reported  ${c.cyan}+${result.delta.sessions} sessions${c.reset}  ${c.cyan}+${result.delta.tokens} tokens${c.reset}`);
  } else if (result.ok) {
    console.log(`  ${c.cyan}·${c.reset}  ${c.dim}${result.reason}${c.reset}`);
  } else {
    console.log(`  ${c.yellow}!${c.reset}  flush did not complete  ${c.dim}(${result.reason}${result.error ? ': ' + result.error : ''})${c.reset}`);
  }
  console.log('');
}

// ── leaderboard profile (local) ───────────────────────────────────────
// `profile` manages the local, opt-in identity used by the public leaderboard.
// Everything is stored locally in config.json; nothing is published until the
// daemon flush runs with profile.enabled + a valid handle (Phase 2).
function readFlag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

// Single source of truth for the profile checklist. `profile`/`profile status`
// renders all of it; mutations point at just the first unfinished step.
// Verification is `done` whichever way it happened — web pairing (doLink sets
// profile.verified) or the gist fallback (profileVerify).
function profileSteps(p) {
  return [
    { key: 'handle',  done: lb.isValidHandle(p.handle), label: 'set a handle',      cmd: 'claude-rpc profile set --handle <name>', note: p.handle },
    { key: 'publish', done: !!p.enabled,                label: 'enable publishing', cmd: 'claude-rpc profile on',                  note: 'daemon republishes automatically' },
    { key: 'verify',  done: !!p.verified,               label: 'verify via GitHub', cmd: 'claude-rpc link <code>',                 note: p.githubUser ? `@${p.githubUser}` : '' },
  ];
}

// One dim pointer at the next unfinished step — what mutations print instead
// of re-rendering the whole dashboard.
function profileNextStep() {
  const p = loadConfig().profile || {};
  const next = profileSteps(p).find((s) => !s.done);
  if (!next) {
    console.log(`     ${c.dim}→  all set — you're live at${c.reset} ${c.cyan}https://claude-rpc.vercel.app/u/${encodeURIComponent(p.handle)}${c.reset}`);
  } else if (next.key === 'verify') {
    console.log(`     ${c.dim}→  next: run${c.reset} ${c.cyan}claude-rpc link${c.reset} ${c.dim}on a machine that's already verified, then${c.reset} ${c.cyan}claude-rpc link <code>${c.reset} ${c.dim}here — first machine? ${LINK_PAGE}${c.reset}`);
  } else {
    console.log(`     ${c.dim}→  next:${c.reset} ${c.cyan}${next.cmd}${c.reset}  ${c.dim}(${next.label})${c.reset}`);
  }
}

function profileStatus() {
  const p = (loadConfig().profile) || {};
  const handleOk = lb.isValidHandle(p.handle);
  const boardUrl = handleOk ? `https://claude-rpc.vercel.app/u/${encodeURIComponent(p.handle)}` : '';

  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ profile${c.reset}  ${c.dim}— public leaderboard identity${c.reset}`);
  console.log('');

  const githubLine = p.githubUser
    ? `${p.githubUser}${p.verified ? `  ${c.green}✓ verified${c.reset}` : `  ${c.dim}(unverified)${c.reset}`}`
    : `${c.dim}—${c.reset}`;
  box('profile', [
    pair('state',  p.enabled ? `${c.green}● publishing${c.reset}` : `${c.dim}○ off${c.reset}`, ''),
    pair('handle', handleOk ? `${c.cyan}${p.handle}${c.reset}` : `${c.dim}(unset)${c.reset}`, ''),
    pair('name',   p.displayName || `${c.dim}—${c.reset}`, ''),
    pair('github', githubLine, ''),
    ...(p.enabled && handleOk ? [pair('board', boardUrl, c.cyan)] : []),
  ]);
  console.log('');

  // Setup checklist — same shape every time, so the user always sees where
  // they are and the exact next command. This is the screen the daemon's
  // breadcrumbs point back to.
  const steps = profileSteps(p);
  if (steps.every((s) => s.done)) {
    console.log(`  ${c.green}✓${c.reset}  all set — you're live at ${c.cyan}${boardUrl}${c.reset}`);
  } else {
    const nextIdx = steps.findIndex((s) => !s.done);
    const lines = steps.map((s, i) => {
      const mark = s.done ? `${c.green}✓${c.reset}` : (i === nextIdx ? `${c.yellow}○${c.reset}` : `${c.dim}○${c.reset}`);
      const label = s.done ? `${c.dim}${s.label}${c.reset}` : `${c.bold}${s.label}${c.reset}`;
      const tail = s.done
        ? `${c.dim}${s.note || 'done'}${c.reset}`
        : `${c.cyan}${s.cmd}${c.reset}${i === nextIdx ? `  ${c.dim}← next${c.reset}` : ''}`;
      return `${mark} ${i + 1}. ${label}${' '.repeat(Math.max(1, 20 - s.label.length))}${tail}`;
    });
    // Link codes are the primary verify path; the gist dance stays available
    // for terminals with no browser nearby.
    if (!steps[2].done) {
      lines.push('');
      lines.push(`${c.dim}the code comes from${c.reset} ${c.cyan}claude-rpc link${c.reset} ${c.dim}on a machine you already verified${c.reset}`);
      lines.push(`${c.dim}first machine? log in at${c.reset} ${c.cyan}${LINK_PAGE}${c.reset} ${c.dim}— or no browser:${c.reset} ${c.cyan}claude-rpc profile verify${c.reset}`);
    }
    box('next steps', lines);
  }
  console.log('');
}

function profileSet(argv) {
  const { normalizeHandle, cleanDisplayName, normalizeGithubUser } = lb;
  const userCfg = readJson(CONFIG_PATH, {});
  const next = { ...(userCfg.profile || {}) };

  const rawHandle = readFlag(argv, 'handle');
  if (rawHandle !== undefined) {
    const h = normalizeHandle(rawHandle);
    if (!h) return fail('invalid handle — use 2–32 chars of letters, numbers, and dashes', { code: EX_USER_ERROR });
    next.handle = h;
  }
  const rawName = readFlag(argv, 'name');
  if (rawName !== undefined) next.displayName = cleanDisplayName(rawName);
  const rawGh = readFlag(argv, 'github');
  if (rawGh !== undefined) {
    if (rawGh === '') next.githubUser = null;
    else {
      const u = normalizeGithubUser(rawGh);
      if (!u) return fail(`invalid GitHub username: ${rawGh}`, { code: EX_USER_ERROR });
      next.githubUser = u;
    }
    // The ✓ belongs to the account that was verified — switching accounts
    // means re-verifying.
    if (next.githubUser !== (userCfg.profile || {}).githubUser) delete next.verified;
  }

  userCfg.profile = next;
  writeFileSync(CONFIG_PATH, JSON.stringify(userCfg, null, 2));
  // One-line confirmation + a pointer at the next step. The full dashboard
  // stays behind `claude-rpc profile` — mutations shouldn't re-render it.
  const saved = [];
  if (rawHandle !== undefined) saved.push(`handle ${next.handle}`);
  if (rawName !== undefined)   saved.push(`name ${next.displayName || '—'}`);
  if (rawGh !== undefined)     saved.push(`github ${next.githubUser || '—'}`);
  console.log(`  ${c.green}✓${c.reset}  profile saved${saved.length ? `  ${c.dim}${saved.join(' · ')}${c.reset}` : ''}`);
  profileNextStep();
}

function profileEnable(on) {
  const userCfg = readJson(CONFIG_PATH, {});
  const next = { ...(userCfg.profile || {}) };
  if (on && !lb.isValidHandle(next.handle)) {
    return fail('set a handle before going on', {
      hint: 'claude-rpc profile set --handle <name>',
      code: EX_BAD_STATE,
    });
  }
  next.enabled = on;
  // Publishing reuses the anonymous community instanceId as the profile's row
  // key. Mint one if the user never opted into community totals, so a
  // profile-only user can still publish.
  if (on) {
    const community = { ...(userCfg.community || {}) };
    if (!community.instanceId) {
      community.instanceId = randomUUID();
      userCfg.community = community;
    }
  }
  userCfg.profile = next;
  writeFileSync(CONFIG_PATH, JSON.stringify(userCfg, null, 2));
  if (on) {
    console.log(`  ${c.green}✓${c.reset}  publishing enabled  ${c.dim}— board syncs on the next flush, or now: ${c.reset}${c.cyan}claude-rpc profile publish${c.reset}`);
    profileNextStep();
  } else {
    console.log(`  ${c.green}✓${c.reset}  leaderboard publishing disabled`);
  }
}

// One-shot publish so you appear on the board immediately, instead of waiting
// for the daemon's next flush.
async function profilePublish() {
  const cfg = loadConfig();
  if (!lb.profileIsPublishable(cfg.profile || {})) {
    return fail('enable the profile first', {
      hint: 'claude-rpc profile set --handle <name> && claude-rpc profile on', code: EX_BAD_STATE,
    });
  }
  const { flushProfile } = await import('./community.js');
  console.log(`  ${c.dim}publishing @${cfg.profile.handle} to the board…${c.reset}`);
  const r = await flushProfile(cfg);
  if (r.ok) {
    console.log(`  ${c.green}✓${c.reset}  published — see it at ${c.cyan}https://claude-rpc.vercel.app/u/${encodeURIComponent(cfg.profile.handle)}${c.reset}`);
  } else if (r.reason === 'rate-limited') {
    console.log(`  ${c.yellow}!${c.reset}  rate-limited — already published in the last minute; the board has you`);
  } else {
    return fail(`publish failed: ${r.reason}${r.error ? ' (' + r.error + ')' : ''}`, { code: EX_SYS_ERROR });
  }
}

// GitHub verification: ask the worker for a one-time token, publish it in a
// public gist (reusing the gist helper), then have the worker confirm it.
async function profileVerify() {
  const cfg = loadConfig();
  const profile = cfg.profile || {};
  const community = cfg.community || {};
  // No --github required up front: the worker treats it as a hint only and
  // takes the authoritative identity from whoever owns the proof gist —
  // and publishing that gist already requires gh auth, so the account is
  // known by the time it matters.
  if (!profile.githubUser) {
    console.log(`  ${c.dim}no --github set — your verified identity will be the account that owns the proof gist${c.reset}`);
  }
  if (!community.instanceId) {
    return fail('enable the profile first', { hint: 'claude-rpc profile on', code: EX_BAD_STATE });
  }
  const endpoint = (community.endpoint || '').replace(/\/+$/, '');
  if (!endpoint) {
    return fail('no community endpoint configured', {
      hint: 'config.json is missing community.endpoint — re-run `claude-rpc setup` to restore the default',
      code: EX_BAD_STATE,
    });
  }

  const post = async (path, body) => {
    const res = await fetch(endpoint + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  try {
    // Make sure the profile row exists server-side before we verify it, so
    // verification works regardless of whether `profile publish` was run first.
    if (lb.profileIsPublishable(profile)) {
      const { flushProfile } = await import('./community.js');
      await flushProfile(cfg);
    }
    console.log(`  ${c.dim}requesting a verification token…${c.reset}`);
    const start = await post('/verify/start', { instanceId: community.instanceId, githubUser: profile.githubUser || null });
    if (!start.json?.token) return fail(`verify/start failed: ${start.json?.error || start.status}`, { code: EX_SYS_ERROR });
    const token = start.json.token;

    const { publishGistFile } = await import('./gist.js');
    console.log(`  ${c.dim}publishing a public proof gist…${c.reset}`);
    const gist = await publishGistFile({
      svg: `claude-rpc leaderboard verification\n${token}\n`,
      filename: 'claude-rpc-verify.txt',
      description: 'claude-rpc profile verification',
      isPublic: true,
    });

    // Hand the worker the gist ID so it fetches that gist directly (no
    // gist-list lag) and reads the real owner — instant, and the owner becomes
    // the verified identity regardless of what --github was set to.
    console.log(`  ${c.dim}confirming with the server…${c.reset}`);
    const check = await post('/verify/check', { instanceId: community.instanceId, gistId: gist.id });
    if (check.json?.verified) {
      const who = check.json.githubUser || gist.owner || profile.githubUser;
      // Persist the authoritative owner + a local verified marker so the
      // profile checklist and future publishes match what got verified.
      const userCfg = readJson(CONFIG_PATH, {});
      userCfg.profile = { ...(userCfg.profile || {}), ...(who ? { githubUser: who } : {}), verified: true };
      writeFileSync(CONFIG_PATH, JSON.stringify(userCfg, null, 2));
      console.log(`  ${c.green}✓${c.reset}  verified as ${c.cyan}@${who}${c.reset} — you'll show the ✓ on the board`);
      if (who && profile.githubUser && who.toLowerCase() !== profile.githubUser.toLowerCase()) {
        console.log(`     ${c.dim}(your gist is owned by @${who}, so the profile now uses that account)${c.reset}`);
      }
    } else {
      console.log(`  ${c.yellow}!${c.reset}  not confirmed: ${check.json?.error || check.status}`);
      console.log(`     ${c.dim}↳ make sure the gist is public, then re-run ${c.reset}${c.cyan}claude-rpc profile verify${c.reset}`);
    }
  } catch (e) {
    return fail(`verification failed: ${e.message}`, {
      hint: 'needs `gh` logged in or GH_TOKEN with gist scope', code: EX_SYS_ERROR,
    });
  }
}

async function doProfile(argv) {
  const sub = (argv[0] || 'status').toLowerCase();
  if (sub === 'status' || sub === '') return profileStatus();
  if (sub === 'set') return profileSet(argv.slice(1));
  if (sub === 'on') return profileEnable(true);
  if (sub === 'off') return profileEnable(false);
  if (sub === 'verify') return profileVerify();
  if (sub === 'publish') return profilePublish();
  fail(`unknown profile subcommand: ${sub}`, {
    hint: 'try: profile [status|set|on|off|verify|publish]',
    code: EX_USER_ERROR,
  });
}

async function doCommunity(argv) {
  const sub = (argv[0] || 'status').toLowerCase();
  if (sub === 'on') return communityOn();
  if (sub === 'off') return communityOff();
  if (sub === 'status' || sub === '') return communityStatus();
  if (sub === 'report' || sub === 'flush') return communityReport();
  fail(`unknown community subcommand: ${sub}`, {
    hint: 'try: community [status|on|off|report]',
    code: EX_USER_ERROR,
  });
}

function tailLog() {
  if (!existsSync(LOG_PATH)) {
    console.log(`  ${c.yellow}!${c.reset}  no log yet  ${c.dim}${LOG_PATH}${c.reset}`);
    console.log(`     ${c.gray}↳ the daemon creates it on first start: ${c.reset}${c.cyan}claude-rpc start${c.reset}`);
    return;
  }
  // Print the last ~30 lines, then follow.
  const tail = tailLines(readFileSync(LOG_PATH, 'utf8'));
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
    } catch { /* read race vs rotation — next watchFile tick recovers */ }
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
    ['setup',     'Install Claude Code hooks + Windows startup entry (~/.claude/settings.json)'],
    ['uninstall', 'Remove Claude Code hooks + Windows startup entry'],
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
    ['badge',     'Render a Shields-style SVG (--metric --range --out --gist)'],
    ['card',      'Render a poster-style SVG summary (--range year|month|week|all)'],
    ['github-stat', 'Render an embeddable profile stat card (--handle --out --gist)'],
    ['statusline', 'One-line status for tmux/shell prompts (--template)'],
    ['calendar',  'Year activity heatmap SVG (--out --gist)'],
    ['session-card', 'Recap card for the current session (--out)'],
    ['mcp install', 'Wire the stats MCP server into Claude Code (one command)'],
    ['mcp',       'Run the MCP server (stdio) — exposes your stats to Claude'],
    ['wrapped',   'Open your animated year-in-review (Claude Wrapped)'],
    ['pause',     'Snooze the Discord card globally (pause [30m|2h], default 1h)'],
    ['resume',    'Lift a pause early'],
    ['export',    'Dump the aggregate as JSON, or daily rows as CSV (--csv --out)'],
    ['private',   'Mark the current directory as private (hide from Discord)'],
    ['public',    'Un-mark the current directory'],
    ['privacy',   'Show resolved visibility for the current directory'],
    ['community', 'Opt in/out of anonymous community totals (on|off|status|report)'],
    ['profile',   'Public leaderboard identity (status|set|on|off|publish|verify)'],
    ['squad',     'Private mini-leaderboards with friends (create|join|leave|status)'],
    ['link',      'Link machines into one profile (mints a code; `link <code>` claims it)'],
    ['doctor',    'Run a diagnostic checklist — common-failure triage (--fix to auto-repair)'],
    ['tail',      'Tail the daemon log file'],
    ['daemon',    'Run daemon in foreground (debug)'],
  ];
  const colW = cmds.reduce((m, [name]) => Math.max(m, name.length), 0);
  console.log('');
  console.log(`  ${c.bold}${c.magenta}◆ claude-rpc${c.reset}  ${c.dim}— Discord Rich Presence for Claude Code${c.reset}`);
  console.log('');
  console.log(`  ${c.dim}Commands:${c.reset}`);
  for (const [name, desc] of cmds) {
    console.log(`    ${c.cyan}${name.padEnd(colW)}${c.reset}  ${desc}`);
  }
  console.log('');
  console.log(`  ${c.dim}First-time setup:${c.reset}`);
  console.log(`    1. ${c.cyan}claude-rpc setup${c.reset} — wires hooks, seeds config, starts the daemon.`);
  console.log(`    2. Open Claude Code and send a prompt — the card appears in Discord.`);
  console.log(`    3. ${c.dim}(optional)${c.reset} Use your own Discord app: set ${c.cyan}clientId${c.reset} in ${c.cyan}config.json${c.reset} and upload art under Rich Presence → Art Assets: ${c.cyan}claude${c.reset}, ${c.cyan}working${c.reset}, ${c.cyan}idle${c.reset}, ${c.cyan}thinking${c.reset}.`);
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
    // `setup` and `install` are aliases as of v0.7: both register hooks AND
    // the Windows startup entry. Older behavior split them (setup = no
    // startup, install = with) but in practice users expect one command
    // to do everything. Non-Windows: addStartupEntry is a no-op + warning.
    case 'setup':
    case 'install': {
      // runInstall prints the phased checklist (or a one-line "already set
      // up" on clean re-runs); the daemon row lands after it, then setupOutro
      // closes the screen — only when something actually changed.
      const { target, changed } = await runInstall({ exePath: EXE_PATH || process.execPath });
      // Slimmer first run: bring the daemon up now so the card appears
      // immediately, instead of making the user run a separate `start`.
      // Best-effort — a start hiccup must never make `setup` look failed.
      try {
        if (IS_NPX) {
          // Our own tree is npm's throwaway _npx cache; launch from the global
          // install setup just promoted to, via the PATH-resolved bin.
          if (!daemonPid()) {
            const child = spawn('claude-rpc', ['daemon'], {
              detached: true, stdio: 'ignore', windowsHide: true,
              shell: process.platform === 'win32',
            });
            child.unref();
            console.log(`  ${c.green}✓${c.reset}  ${'daemon launched'.padEnd(16)}${c.dim}log ${shortPath(LOG_PATH)}${c.reset}`);
          } else {
            console.log(`  ${c.cyan}·${c.reset}  ${'daemon running'.padEnd(16)}${c.dim}pid ${daemonPid()}${c.reset}`);
          }
        } else {
          startDaemon();
        }
      } catch (e) {
        console.log(`  ${c.yellow}!${c.reset}  ${'daemon start'.padEnd(16)}${c.dim}couldn't auto-start: ${e.message}${c.reset}`);
        console.log(`     ${c.gray}↳ run \`claude-rpc start\` when you're ready${c.reset}`);
      }
      setupOutro(target, changed);
      break;
    }
    case 'uninstall': await runUninstall(); break;
    case 'upgrade-config':
      if (!migrateConfig()) console.log(`  ${c.green}✓${c.reset}  config already current — nothing to migrate`);
      break;
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
    case 'badge':     await doBadge(process.argv.slice(3)); break;
    case 'card':      await doCard(process.argv.slice(3)); break;
    case 'github-stat': await doGithubStat(process.argv.slice(3)); break;
    case 'statusline': doStatusline(process.argv.slice(3)); break;
    case 'calendar':  await doCalendar(process.argv.slice(3)); break;
    case 'session-card': await doSessionCard(process.argv.slice(3)); break;
    case 'mcp': {
      const sub = process.argv[3];
      if (sub === 'install')   { doMcpInstall(process.argv.slice(4)); break; }
      if (sub === 'uninstall') { doMcpUninstall(process.argv.slice(4)); break; }
      await doMcp();
      break;
    }
    case 'wrapped':   process.env.CLAUDE_RPC_OPEN_PATH = '/wrapped'; await import('./server/index.js'); break;
    case 'pause':     doPause(process.argv.slice(3)); break;
    case 'resume':
    case 'unpause':   doResume(); break;
    case 'export':    await doExport(process.argv.slice(3)); break;
    case 'private':   doPrivate(); break;
    case 'public':    doPublic(); break;
    case 'privacy':   doPrivacy(); break;
    case 'community': await doCommunity(process.argv.slice(3)); break;
    case 'profile':   await doProfile(process.argv.slice(3)); break;
    case 'squad':     await doSquadCmd(process.argv.slice(3)); break;
    case 'link':      await doLink(process.argv.slice(3)); break;
    case 'doctor': {
      const { runDoctor, fixPlan } = await import('./doctor.js');
      const fix = process.argv.includes('--fix');
      const code = runDoctor();
      if (!fix) process.exit(code);

      // --fix: apply ONLY the repairs the checklist flagged, in dependency
      // order, reporting each — instead of blindly re-running everything.
      const plan = fixPlan();
      if (plan.length === 0) {
        console.log(`\n  ${c.green}◆ --fix${c.reset} ${c.dim}— nothing to repair; everything that can be auto-fixed already passes.${c.reset}`);
        process.exit(code);
      }
      console.log(`\n  ${c.cyan}◆ --fix${c.reset} ${c.dim}— applying ${plan.length} targeted repair${plan.length === 1 ? '' : 's'}: ${plan.join(', ')}${c.reset}`);

      let restarted = false;
      for (const kind of plan) {
        try {
          if (kind === 'setup') {
            await runInstall({ exePath: EXE_PATH || process.execPath });
            console.log(`  ${c.green}✓${c.reset}  config + hooks repaired`);
          } else if (kind === 'rescan') {
            doScan(true);
            console.log(`  ${c.green}✓${c.reset}  aggregate rebuilt from transcripts`);
          } else if (kind === 'daemon') {
            restartDaemon();
            restarted = true;
            console.log(`  ${c.green}✓${c.reset}  daemon (re)starting`);
          } else if (kind === 'discord') {
            console.log(`  ${c.yellow}!${c.reset}  discord IPC is down — open the Discord ${c.bold}desktop${c.reset} app (RPC isn't exposed by the browser client). Not auto-fixable.`);
          }
        } catch (e) {
          console.log(`  ${c.red}✗${c.reset}  ${kind} step failed: ${e.message}`);
        }
      }
      // A 'setup' rewire only takes effect once the daemon reloads, so ensure a
      // restart even if the daemon wasn't itself flagged.
      if (plan.includes('setup') && !restarted) restartDaemon();
      console.log(`  ${c.dim}run ${c.cyan}claude-rpc doctor${c.reset}${c.dim} again in a few seconds to confirm.${c.reset}`);
      break; // let the restart timer fire before the process drains
    }
    case 'tail':
    case 'logs':
    case 'log':       tailLog(); break;
    case 'hook':      runHookCli(process.argv[3] || 'unknown'); break;
    case 'daemon':    await import('./daemon.js'); break;
    default: {
      if (packagedDefault) {
        if (!isInstalled()) {
          const { target } = await runInstall({ exePath: EXE_PATH || process.execPath });
          startDaemon();
          setupOutro(target);
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
          console.log('');
          console.log(`  ${c.bold}${c.magenta}◆ claude-rpc${c.reset}  ${c.dim}— already installed; refreshing hooks + config${c.reset}`);
          try {
            const target = ensureCanonicalExe(process.execPath);
            migrateConfig();
            installHooks(target);
          } catch (e) {
            console.warn(`  ${c.yellow}!${c.reset}  ${'refresh skipped'.padEnd(16)}${c.dim}${e.message}${c.reset}`);
          }
          const wasRunning = stopDaemon({ quiet: true });
          try { if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH); } catch { /* state.json locked or already gone — next hook will recreate it */ }
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
        // Version in the hint is deliberate: the #1 cause of "unknown
        // command" in the wild is a stale global install resolving instead of
        // the version the user read the docs for. Make the skew visible.
        fail(`unknown command: ${cmd}`, {
          hint: [
            'run `claude-rpc --help` for the full command list',
            `this install is v${VERSION} — if the docs mention \`${cmd}\`, update first: npm install -g claude-rpc@latest`,
          ],
          code: EX_USER_ERROR,
        });
      }
    }
  }
})();
