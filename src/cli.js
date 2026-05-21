#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, watchFile } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

// Force the console code page to UTF-8 (65001) on Windows so Unicode box
// drawing, block elements, and other chars render correctly. Default cmd.exe
// code page on Win10 is 437/850, which displays many of our chars as `?`.
// Hook events (no TTY) skip this — they don't print anything user-visible.
if (process.platform === 'win32' && process.stdout.isTTY) {
  try { spawnSync('chcp.com', ['65001'], { stdio: 'ignore', windowsHide: true }); } catch {}
}
import { CLAUDE_SETTINGS, HOOK_SCRIPT, DAEMON_SCRIPT, PID_PATH, STATE_PATH, LOG_PATH, AGGREGATE_PATH, CONFIG_PATH, IS_PACKAGED, EXE_PATH } from './paths.js';
import { readState } from './state.js';
import { buildVars, fillTemplate, humanProject, humanTool, applyIdle, framePasses } from './format.js';
import { scan, readAggregate, findLiveSessions, dayKey, weekKey } from './scanner.js';
import { runHookCli } from './hook.js';
import { install as runInstall, uninstall as runUninstall, isInstalled } from './install.js';
import { startTui } from './tui.js';
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

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function hookCmd(event) {
  const script = HOOK_SCRIPT.replace(/\\/g, '/');
  return `node "${script}" ${event}`;
}

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'Notification', 'SessionEnd'];

function installHooks() {
  const settings = readJson(CLAUDE_SETTINGS, {});
  settings.hooks = settings.hooks || {};
  for (const event of EVENTS) {
    const wanted = hookCmd(event);
    const bucket = settings.hooks[event] = settings.hooks[event] || [];
    let entry = bucket.find((b) => Array.isArray(b.hooks) && b.hooks.some((h) => h.command?.includes('claude-rpc') || h.command?.includes('CLAUDE/src/hook.js') || h.command?.includes(HOOK_SCRIPT.replace(/\\/g, '/'))));
    if (entry) {
      entry.hooks = entry.hooks.map((h) => (h.command?.includes('hook.js') ? { ...h, command: wanted } : h));
    } else {
      bucket.push({ matcher: '', hooks: [{ type: 'command', command: wanted }] });
    }
  }
  writeJson(CLAUDE_SETTINGS, settings);
  console.log(`${c.green}✓${c.reset} Installed Claude RPC hooks into ${c.cyan}${CLAUDE_SETTINGS}${c.reset}`);
}

function uninstallHooks() {
  const settings = readJson(CLAUDE_SETTINGS, {});
  if (!settings.hooks) { console.log('No hooks to remove.'); return; }
  for (const event of EVENTS) {
    const bucket = settings.hooks[event];
    if (!Array.isArray(bucket)) continue;
    settings.hooks[event] = bucket
      .map((entry) => ({ ...entry, hooks: (entry.hooks || []).filter((h) => !h.command?.includes('hook.js')) }))
      .filter((entry) => (entry.hooks || []).length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  writeJson(CLAUDE_SETTINGS, settings);
  console.log(`${c.green}✓${c.reset} Removed Claude RPC hooks from ${CLAUDE_SETTINGS}`);
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
  // in dev mode it's the src/daemon.js path passed to node.
  const args = IS_PACKAGED ? ['daemon'] : [DAEMON_SCRIPT];
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true });
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
  const config = readJson(CONFIG_PATH, {});
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
  } else {
    console.log(`  ${c.dim}No aggregate yet — run ${c.reset}${c.cyan}claude-rpc scan${c.reset}`);
    console.log('');
  }
}

function showToday() {
  const state = readState();
  const aggregate = readAggregate();
  const config = readJson(CONFIG_PATH, {});
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
  const config = readJson(CONFIG_PATH, {});
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
  const config = readJson(CONFIG_PATH, {});
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
  console.log(`${c.dim}Aggregate written to ${AGGREGATE_PATH}${c.reset}`);
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

function help() {
  const cmds = [
    ['setup',     'Install Claude Code hooks (~/.claude/settings.json)'],
    ['uninstall', 'Remove Claude Code hooks'],
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
}

// Packaged exe: `claude-rpc.exe` with no args → first-run install + start.
// `claude-rpc.exe hook PreToolUse` → handle hook.
// Dev mode keeps the original `help` fallback so behavior is unchanged.
const packagedDefault = IS_PACKAGED && !cmd;

// Wrapped in an async IIFE so the same source compiles cleanly under both
// ESM (dev) and CommonJS (esbuild → pkg) — CJS doesn't allow top-level await.
(async () => {
  switch (cmd) {
    case 'setup':     await runInstall({ exePath: EXE_PATH || process.execPath, withStartup: false }); break;
    case 'install':   await runInstall({ exePath: EXE_PATH || process.execPath }); break;
    case 'uninstall': await runUninstall(); break;
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
    case 'serve':     await import('./server.js'); break;
    case 'preview':   showPreview(); break;
    case 'scan':      doScan(false); break;
    case 'rescan':    doScan(true); break;
    case 'tail':
    case 'logs':
    case 'log':       tailLog(); break;
    case 'hook':      runHookCli(process.argv[3] || 'unknown'); break;
    case 'daemon':    await import('./daemon.js'); break;
    default: {
      if (packagedDefault) {
        if (!isInstalled()) {
          await runInstall({ exePath: EXE_PATH || process.execPath });
        } else {
          console.log('Claude RPC is installed. Starting daemon…');
        }
        startDaemon();
      } else {
        help();
      }
    }
  }
})();
