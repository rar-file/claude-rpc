// Interactive terminal dashboard. 5 keyboard-navigable tabs, live refresh.
// Characters chosen for Windows 10 cmd.exe compatibility (CP437-safe box
// drawing + basic block elements). Only ANSI escapes that Win10 1607+
// supports natively (Node enables VT processing automatically).

import process from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { readState } from './state.js';
import { readAggregate, findLiveSessions, dayKey, weekKey } from './scanner.js';
import { buildVars, applyIdle, humanProject, humanTool } from './format.js';
import { CONFIG_PATH, PID_PATH } from './paths.js';

// ── ANSI ────────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const RESET = ESC + '0m';
const CLEAR = ESC + '2J' + ESC + 'H';
const HIDE_CURSOR = ESC + '?25l';
const SHOW_CURSOR = ESC + '?25h';
const ALT_SCREEN_ON = ESC + '?1049h';
const ALT_SCREEN_OFF = ESC + '?1049l';

const C = {
  reset: RESET,
  dim:    ESC + '2m',
  bold:   ESC + '1m',
  red:    ESC + '31m',
  green:  ESC + '32m',
  yellow: ESC + '33m',
  blue:   ESC + '34m',
  magenta:ESC + '35m',
  cyan:   ESC + '36m',
  gray:   ESC + '90m',
  brBold: ESC + '1;36m',
};
const ansiRe = /\x1b\[[0-9;]*m/g;
const visLen = (s) => String(s).replace(ansiRe, '').length;

// ── Box drawing (CP437-safe; render on Win10 cmd, PowerShell, Terminal) ─────
const B = { tl:'┌', tr:'┐', bl:'└', br:'┘', h:'─', v:'│', lt:'├', rt:'┤', t:'┬', b:'┴', x:'┼' };

// ── Tabs ────────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'now',      label: 'Now' },
  { key: 'today',    label: 'Today' },
  { key: 'week',     label: 'Week' },
  { key: 'streak',   label: 'Streak' },
  { key: 'lifetime', label: 'Lifetime' },
];
let currentTab = 0;
let refreshTimer = null;
let exiting = false;

// ── Data ────────────────────────────────────────────────────────────────────
function loadSnapshot() {
  let state = readState();
  state.liveSessions = findLiveSessions({ thresholdMs: 90_000 });
  const config = existsSync(CONFIG_PATH)
    ? (() => { try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } })()
    : {};
  state = applyIdle(state, config);
  const aggregate = readAggregate() || {};
  const vars = buildVars(state, config, aggregate);
  return { state, config, aggregate, vars };
}

function daemonPid() {
  if (!existsSync(PID_PATH)) return null;
  try {
    const pid = Number(readFileSync(PID_PATH, 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

// ── Layout helpers ──────────────────────────────────────────────────────────
function width()  { return Math.max(60, process.stdout.columns || 80); }
function height() { return Math.max(20, process.stdout.rows    || 24); }

function pad(s, n) {
  const len = visLen(s);
  return len >= n ? s : s + ' '.repeat(n - len);
}
function center(s, n) {
  const len = visLen(s);
  if (len >= n) return s;
  const left = Math.floor((n - len) / 2);
  return ' '.repeat(left) + s + ' '.repeat(n - len - left);
}

function bar(value, max, w = 16, fillChar = '█', emptyChar = ' ') {
  if (!max || max <= 0) return ''.padEnd(w);
  const filled = Math.max(0, Math.min(w, Math.round((value / max) * w)));
  return fillChar.repeat(filled) + emptyChar.repeat(w - filled);
}

// ── Header / footer ─────────────────────────────────────────────────────────
function drawHeader(w) {
  const pid = daemonPid();
  const dot   = pid ? `${C.green}●${C.reset}` : `${C.red}○${C.reset}`;
  const label = pid ? `${C.green}running${C.reset} ${C.dim}pid ${pid}${C.reset}` : `${C.red}not running${C.reset}`;

  const title = ` ${C.bold}Claude RPC${C.reset}  ${dot} ${label}`;
  const titleLen = visLen(title);

  const tabsRaw = TABS.map((t, i) =>
    i === currentTab
      ? `${C.bold}${C.cyan}[${t.label}]${C.reset}`
      : `${C.dim} ${t.label} ${C.reset}`
  ).join(' ');

  const right = `${C.dim}q quit${C.reset}`;
  const rightLen = visLen(right);

  const lines = [];
  lines.push(`${C.gray}${B.tl}${B.h.repeat(w - 2)}${B.tr}${C.reset}`);
  lines.push(`${C.gray}${B.v}${C.reset}${title}${' '.repeat(Math.max(1, w - 2 - titleLen - rightLen - 1))}${right} ${C.gray}${B.v}${C.reset}`);
  const tabsLen = visLen(tabsRaw);
  lines.push(`${C.gray}${B.v}${C.reset} ${tabsRaw}${' '.repeat(Math.max(0, w - 3 - tabsLen))}${C.gray}${B.v}${C.reset}`);
  lines.push(`${C.gray}${B.lt}${B.h.repeat(w - 2)}${B.rt}${C.reset}`);
  return lines;
}

function drawFooter(w) {
  const keys = [
    `${C.bold}1${C.dim}-${C.bold}5${C.reset}${C.dim} tabs${C.reset}`,
    `${C.bold}←→${C.reset}${C.dim} move${C.reset}`,
    `${C.bold}r${C.reset}${C.dim} refresh${C.reset}`,
    `${C.bold}q${C.reset}${C.dim} quit${C.reset}`,
  ].join(`  ${C.gray}·${C.reset}  `);

  const lines = [];
  lines.push(`${C.gray}${B.lt}${B.h.repeat(w - 2)}${B.rt}${C.reset}`);
  const keysLen = visLen(keys);
  lines.push(`${C.gray}${B.v}${C.reset} ${keys}${' '.repeat(Math.max(0, w - 3 - keysLen))}${C.gray}${B.v}${C.reset}`);
  lines.push(`${C.gray}${B.bl}${B.h.repeat(w - 2)}${B.br}${C.reset}`);
  return lines;
}

function wrapContent(rows, w) {
  // Wrap each row in │ … │ borders, padded to interior width.
  const inner = w - 4; // 2 for borders + 2 spaces padding
  return rows.map((r) => {
    const padded = pad(r, inner);
    return `${C.gray}${B.v}${C.reset}  ${padded}  ${C.gray}${B.v}${C.reset}`;
  });
}

// ── Tab: Now ────────────────────────────────────────────────────────────────
function tabNow(w, data) {
  const v = data.vars;
  const out = [];
  out.push('');
  out.push(`${C.bold}${v.statusVerbose}${C.reset} ${C.dim}in${C.reset} ${C.bold}${v.project}${C.reset}`);
  out.push(`${C.dim}${v.modelPretty}${C.reset}    ${C.cyan}${v.duration}${C.reset} ${C.dim}elapsed${C.reset}`);
  out.push('');
  out.push(`${C.dim}prompts${C.reset}    ${C.yellow}${String(v.messages).padStart(8)}${C.reset}`);
  out.push(`${C.dim}tool calls${C.reset} ${C.yellow}${String(v.tools).padStart(8)}${C.reset}`);
  out.push(`${C.dim}files${C.reset}      ${C.cyan}${String(v.filesOpened).padStart(8)}${C.reset} ${C.dim}opened · ${v.filesEdited} edited · ${v.filesRead} read${C.reset}`);
  out.push(`${C.dim}tokens${C.reset}     ${C.bold}${v.tokensFmt.padStart(8)}${C.reset} ${C.dim}(${v.inputTokens} in · ${v.outputTokens} out · ${v.cacheTokens} cache)${C.reset}`);
  out.push('');
  if (v.currentTool) {
    out.push(`${C.dim}current${C.reset}    ${C.bold}${v.currentToolPretty}${C.reset} ${C.cyan}${v.currentFilePretty}${C.reset}`);
  }
  if (v.concurrent > 1) {
    out.push('');
    out.push(`${C.magenta}${v.concurrentLabel}${C.reset} ${C.dim}— ${v.concurrentListPretty}${C.reset}`);
  }
  return out;
}

// ── Tab: Today ──────────────────────────────────────────────────────────────
function tabToday(w, data) {
  const v = data.vars;
  const agg = data.aggregate;
  const out = [];
  out.push('');
  out.push(`${C.bold}Today${C.reset}    ${C.green}${v.todayHours}${C.reset} ${C.dim}active${C.reset}`);
  out.push('');
  out.push(`${C.dim}prompts${C.reset}    ${C.yellow}${String(v.todayPrompts).padStart(8)}${C.reset}`);
  out.push(`${C.dim}tool calls${C.reset} ${C.yellow}${v.todayToolsFmt.padStart(8)}${C.reset}`);
  out.push(`${C.dim}sessions${C.reset}   ${C.cyan}${String(v.todaySessions).padStart(8)}${C.reset}`);
  out.push(`${C.dim}tokens${C.reset}     ${C.bold}${v.todayTokensFmt.padStart(8)}${C.reset} ${C.dim}grand total${C.reset}`);
  out.push('');
  // Hour-of-day histogram (compact)
  if (agg.byHour && Object.keys(agg.byHour).length) {
    out.push(`${C.dim}when you code · hour of day${C.reset}`);
    const heightChars = ' ▁▂▃▄▅▆▇█';
    let max = 0;
    for (let h = 0; h < 24; h++) max = Math.max(max, agg.byHour?.[h]?.activeMs || 0);
    if (max > 0) {
      const bars = [];
      for (let h = 0; h < 24; h++) {
        const ms = agg.byHour?.[h]?.activeMs || 0;
        const idx = ms > 0 ? Math.max(1, Math.min(8, Math.round((ms / max) * 8))) : 0;
        const ch = heightChars[idx];
        bars.push(h === v.peakHourNum ? `${C.magenta}${C.bold}${ch}${C.reset}` : `${C.green}${ch}${C.reset}`);
      }
      out.push('  ' + bars.join(''));
      out.push('  ' + `${C.dim}00  03  06  09  12  15  18  21${C.reset}`);
    }
  }
  return out;
}

// ── Tab: Week ───────────────────────────────────────────────────────────────
function tabWeek(w, data) {
  const v = data.vars;
  const agg = data.aggregate;
  const out = [];
  out.push('');
  out.push(`${C.bold}This week${C.reset}  ${C.dim}${weekKey(Date.now())}${C.reset}    ${C.green}${v.weekHours}${C.reset} ${C.dim}active${C.reset}`);
  out.push('');
  out.push(`${C.dim}prompts${C.reset}    ${C.yellow}${String(v.weekPrompts).padStart(8)}${C.reset}`);
  out.push(`${C.dim}tool calls${C.reset} ${C.yellow}${v.weekToolsFmt.padStart(8)}${C.reset}`);
  out.push(`${C.dim}sessions${C.reset}   ${C.cyan}${String(v.weekSessions).padStart(8)}${C.reset}`);
  out.push(`${C.dim}tokens${C.reset}     ${C.bold}${v.weekTokensFmt.padStart(8)}${C.reset}`);
  out.push('');
  if (agg.byDay) {
    out.push(`${C.dim}daily breakdown${C.reset}`);
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
      const ms = agg.byDay[k]?.activeMs || 0;
      const isFuture = d > now;
      const isToday = k === dayKey(now.getTime());
      days.push({ label: `${dayName} ${k.slice(5)}`, ms, isFuture, isToday });
    }
    const maxMs = Math.max(...days.map((d) => d.ms)) || 1;
    for (const { label, ms, isFuture, isToday } of days) {
      if (isFuture) {
        out.push(`  ${C.dim}${label.padEnd(11)}${' '.repeat(20)}     —${C.reset}`);
      } else {
        const h = ms / 3_600_000;
        const hStr = h < 1 ? `${Math.round(h * 60)}m` : (h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`);
        const prefix = isToday ? C.bold : '';
        out.push(`  ${prefix}${label.padEnd(11)}${C.reset} ${C.magenta}${bar(ms, maxMs, 18)}${C.reset} ${C.cyan}${hStr.padStart(5)}${C.reset}${isToday ? ` ${C.dim}← today${C.reset}` : ''}`);
      }
    }
  }
  return out;
}

// ── Tab: Streak ─────────────────────────────────────────────────────────────
function tabStreak(w, data) {
  const v = data.vars;
  const out = [];
  out.push('');
  out.push(`${C.bold}${C.magenta}${v.streak}${C.reset} ${C.dim}day streak${C.reset}    ${C.dim}longest${C.reset} ${C.cyan}${v.longestStreak}${C.reset}`);
  out.push('');
  out.push(`${C.dim}days on claude${C.reset}   ${C.cyan}${String(v.daysSinceFirst).padStart(8)}${C.reset}`);
  if (v.bestDayDate) {
    out.push('');
    out.push(`${C.dim}best day${C.reset}         ${C.bold}${v.bestDayHours}${C.reset} ${C.dim}on ${v.bestDayDate}${C.reset}`);
    out.push(`                 ${C.dim}${v.bestDayPrompts} prompts · ${v.bestDayTokensFmt} tokens${C.reset}`);
  }
  if (v.peakHour) {
    out.push('');
    out.push(`${C.dim}peak hour${C.reset}        ${C.bold}${v.peakHour}${C.reset}   ${C.dim}${v.peakHourActiveLabel}${C.reset}`);
  }
  if (v.topEditedFile) {
    out.push('');
    out.push(`${C.dim}hotspot${C.reset}          ${C.bold}${v.topEditedFile}${C.reset}   ${C.dim}${v.topEditedCountLabel}${C.reset}`);
  }
  return out;
}

// ── Tab: Lifetime ───────────────────────────────────────────────────────────
function tabLifetime(w, data) {
  const v = data.vars;
  const agg = data.aggregate;
  const out = [];
  out.push('');
  out.push(`${C.bold}All-time${C.reset}    ${C.green}${v.allHours}${C.reset} ${C.dim}active · ${v.allWallHours} wall${C.reset}`);
  out.push('');
  out.push(`${C.dim}sessions${C.reset}   ${C.yellow}${String(v.allSessions).padStart(8)}${C.reset} ${C.dim}(+${v.allSubagentRuns} subagent runs)${C.reset}`);
  out.push(`${C.dim}prompts${C.reset}    ${C.yellow}${v.allMessagesFmt.padStart(8)}${C.reset}`);
  out.push(`${C.dim}tool calls${C.reset} ${C.yellow}${v.allToolsFmt.padStart(8)}${C.reset}`);
  out.push(`${C.dim}files${C.reset}      ${C.cyan}${v.allFilesFmt.padStart(8)}${C.reset}`);
  out.push(`${C.dim}tokens${C.reset}     ${C.bold}${C.magenta}${v.allTokensFmt.padStart(8)}${C.reset} ${C.dim}grand total${C.reset}`);
  out.push(`             ${C.dim}${v.allInputTokens} in + ${v.allOutputTokens} out + ${v.allCacheTokens} cache${C.reset}`);
  out.push('');
  // Top projects (compact)
  const projects = agg.projects || {};
  const top = Object.entries(projects)
    .sort((a, b) => b[1].activeMs - a[1].activeMs)
    .slice(0, 4);
  if (top.length) {
    out.push(`${C.dim}top projects${C.reset}`);
    const maxMs = top[0][1].activeMs;
    for (const [name, p] of top) {
      const h = p.activeMs / 3_600_000;
      const hStr = h < 1 ? `${Math.round(h * 60)}m` : (h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`);
      const pretty = humanProject(name).slice(0, 18).padEnd(20);
      out.push(`  ${pretty} ${C.magenta}${bar(p.activeMs, maxMs, 16)}${C.reset} ${C.cyan}${hStr.padStart(5)}${C.reset}`);
    }
  }
  return out;
}

// ── Render ──────────────────────────────────────────────────────────────────
const TAB_RENDERERS = [tabNow, tabToday, tabWeek, tabStreak, tabLifetime];

function render() {
  const w = width();
  const h = height();
  const data = loadSnapshot();

  const header = drawHeader(w);
  const footer = drawFooter(w);
  const content = TAB_RENDERERS[currentTab](w, data);

  // Wrap content rows in vertical borders + pad to fit available height.
  const wrapped = wrapContent(content, w);
  const availableRows = h - header.length - footer.length;
  while (wrapped.length < availableRows) wrapped.push(wrapContent([''], w)[0]);
  if (wrapped.length > availableRows) wrapped.length = availableRows;

  const screen = [...header, ...wrapped, ...footer].join('\n');
  process.stdout.write(CLEAR + screen);
}

// ── Input ───────────────────────────────────────────────────────────────────
function cleanup() {
  if (exiting) return;
  exiting = true;
  if (refreshTimer) clearInterval(refreshTimer);
  try { process.stdin.setRawMode(false); } catch {}
  process.stdin.pause();
  process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF + '\n');
  process.exit(0);
}

function handleKey(buf) {
  const key = buf.toString();
  // Quit
  if (key === '' || key.toLowerCase() === 'q') return cleanup();
  // Refresh
  if (key.toLowerCase() === 'r') return render();
  // Number jump
  if (key >= '1' && key <= String(TABS.length)) {
    currentTab = Number(key) - 1;
    return render();
  }
  // Arrow keys
  if (key === '[C' || key === '[B' || key === '\t') {
    currentTab = (currentTab + 1) % TABS.length;
    return render();
  }
  if (key === '[D' || key === '[A') {
    currentTab = (currentTab - 1 + TABS.length) % TABS.length;
    return render();
  }
}

export function startTui() {
  if (!process.stdout.isTTY) {
    console.error('claude-rpc status: this terminal is not a TTY; try `claude-rpc status --dump` for plain output.');
    process.exit(1);
  }
  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR);

  try { process.stdin.setRawMode(true); } catch {}
  process.stdin.resume();
  process.stdin.on('data', handleKey);

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
  // Restore terminal on any exit path
  process.on('exit', () => {
    try { process.stdin.setRawMode(false); } catch {}
    process.stdout.write(SHOW_CURSOR + ALT_SCREEN_OFF);
  });
  process.stdout.on('resize', () => render());

  refreshTimer = setInterval(render, 3000);
  render();
}
