// Interactive terminal dashboard. Keyboard-navigable tabs, live refresh.
// Designed to render correctly on Windows 10 cmd.exe, PowerShell 5.1, and
// Windows Terminal: no full outer box, no alternative screen buffer (some
// older terminals don't honor it), only ANSI color + horizontal separator
// lines for structure.

import process from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { readActiveState } from './state.js';
import { readAggregate, findLiveSessions, weekKey } from './scanner.js';
import { weekGrid } from './week.js';
import { buildVars, applyIdle, humanProject } from './format.js';
import { loadConfig } from './config.js';
import { PID_PATH } from './paths.js';
import { fmtCost } from './pricing.js';
import { heat } from './ui.js';

// ── ANSI ────────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const RESET = ESC + '0m';
const CLEAR = ESC + '2J' + ESC + 'H';
const HIDE_CURSOR = ESC + '?25l';
const SHOW_CURSOR = ESC + '?25h';

const C = {
  reset:   RESET,
  dim:     ESC + '2m',
  bold:    ESC + '1m',
  red:     ESC + '31m',
  green:   ESC + '32m',
  yellow:  ESC + '33m',
  magenta: ESC + '35m',
  cyan:    ESC + '36m',
  gray:    ESC + '90m',
};
const ansiRe = /\x1b\[[0-9;]*m/g;
const visLen = (s) => String(s).replace(ansiRe, '').length;

// ── Tabs ────────────────────────────────────────────────────────────────────
const TABS = [
  { key: 'now',      label: 'Now' },
  { key: 'today',    label: 'Today' },
  { key: 'week',     label: 'Week' },
  { key: 'streak',   label: 'Streak' },
  { key: 'lifetime', label: 'Lifetime' },
  { key: 'cost',     label: 'Cost' },
  { key: 'code',     label: 'Code' },
];
let currentTab = 0;
let refreshTimer = null;
let exiting = false;

// ── Data ────────────────────────────────────────────────────────────────────
function loadSnapshot() {
  let state = readActiveState();
  state.liveSessions = findLiveSessions({ thresholdMs: 90_000 });
  const config = loadConfig();
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
function width()  { return Math.max(50, Math.min(120, process.stdout.columns || 80)); }
function height() { return Math.max(20, process.stdout.rows || 24); }

function rule(w) { return C.gray + '─'.repeat(w - 4) + C.reset; }
// Heat-graded fill (same ramp as the CLI views) — intensity reads at a glance.
function bar(value, max, w = 16) {
  if (!max || max <= 0) return ''.padEnd(w);
  const filled = Math.max(0, Math.min(w, Math.round((value / max) * w)));
  // heat() is NO_COLOR-aware (returns '' when color is off); the old
  // `|| C.magenta` fallback wasn't, so it injected a raw escape under NO_COLOR.
  return `${heat(value / max)}${'█'.repeat(filled)}${C.reset}` + ' '.repeat(w - filled);
}

// Wrap each content line with a 2-space left margin.
function indent(rows) { return rows.map((r) => '  ' + r); }

// ── Header / footer ─────────────────────────────────────────────────────────
function drawHeader(w) {
  const pid = daemonPid();
  const status = pid
    ? `${C.green}● running${C.reset} ${C.dim}pid ${pid}${C.reset}`
    : `${C.red}○ not running${C.reset}`;

  const title = `${C.bold}Claude RPC${C.reset}`;
  // First line: title left, status right
  const left = title;
  const right = status;
  const innerWidth = w - 4;
  const padCount = Math.max(1, innerWidth - visLen(left) - visLen(right));
  const line1 = '  ' + left + ' '.repeat(padCount) + right;

  // Tabs line
  const tabBits = TABS.map((t, i) => {
    if (i === currentTab) return `${C.bold}${C.cyan}${t.label}${C.reset}`;
    return `${C.dim}${t.label}${C.reset}`;
  });
  const tabs = tabBits.join(`  ${C.gray}·${C.reset}  `);
  const line2 = '  ' + tabs;

  return [line1, line2, '  ' + rule(w)];
}

function drawFooter(w) {
  const keys = `${C.dim}1-7 jump${C.reset}  ${C.gray}·${C.reset}  ${C.dim}←→ h l${C.reset}  ${C.gray}·${C.reset}  ${C.dim}r refresh${C.reset}  ${C.gray}·${C.reset}  ${C.dim}q quit${C.reset}`;
  return ['  ' + rule(w), '  ' + keys];
}

// ── Tab renderers ───────────────────────────────────────────────────────────
function tabNow(_, data) {
  const v = data.vars;
  const out = [];
  out.push('');
  out.push(`${C.bold}${v.statusVerbose}${C.reset} ${C.dim}in${C.reset} ${C.bold}${v.project}${C.reset}`);
  out.push(`${C.dim}${v.modelPretty}${C.reset}    ${C.cyan}${v.duration}${C.reset} ${C.dim}elapsed${C.reset}`);
  out.push('');
  out.push(`${C.dim}prompts${C.reset}     ${C.yellow}${String(v.messages).padStart(8)}${C.reset}`);
  out.push(`${C.dim}tool calls${C.reset}  ${C.yellow}${String(v.tools).padStart(8)}${C.reset}`);
  out.push(`${C.dim}files${C.reset}       ${C.cyan}${String(v.filesOpened).padStart(8)}${C.reset} ${C.dim}opened · ${v.filesEdited} edited · ${v.filesRead} read${C.reset}`);
  out.push(`${C.dim}tokens${C.reset}      ${C.bold}${v.tokensFmt.padStart(8)}${C.reset} ${C.dim}(${v.inputTokens} in · ${v.outputTokens} out · ${v.cacheTokens} cache)${C.reset}`);
  if (v.currentTool) {
    out.push('');
    out.push(`${C.dim}current${C.reset}     ${C.bold}${v.currentToolPretty}${C.reset} ${C.cyan}${v.currentFilePretty}${C.reset}`);
  }
  if (v.concurrent > 1) {
    out.push('');
    out.push(`${C.magenta}${v.concurrentLabel}${C.reset} ${C.dim}— ${v.concurrentListPretty}${C.reset}`);
  }
  return out;
}

function tabToday(_, data) {
  const v = data.vars;
  const agg = data.aggregate;
  const out = [];
  out.push('');
  out.push(`${C.bold}Today${C.reset}    ${C.green}${v.todayHours}${C.reset} ${C.dim}active${C.reset}`);
  out.push('');
  out.push(`${C.dim}prompts${C.reset}     ${C.yellow}${String(v.todayPrompts).padStart(8)}${C.reset}`);
  out.push(`${C.dim}tool calls${C.reset}  ${C.yellow}${v.todayToolsFmt.padStart(8)}${C.reset}`);
  out.push(`${C.dim}sessions${C.reset}    ${C.cyan}${String(v.todaySessions).padStart(8)}${C.reset}`);
  out.push(`${C.dim}tokens${C.reset}      ${C.bold}${v.todayTokensFmt.padStart(8)}${C.reset} ${C.dim}grand total${C.reset}`);
  if (agg.byHour && Object.keys(agg.byHour).length) {
    out.push('');
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
        bars.push(h === v.peakHourNum ? `${C.bold}${heat(1)}${ch}${C.reset}` : `${heat(ms / max)}${ch}${C.reset}`);
      }
      out.push(bars.join(''));
      out.push(`${C.dim}00  03  06  09  12  15  18  21${C.reset}`);
    }
  }
  return out;
}

function tabWeek(_, data) {
  const v = data.vars;
  const agg = data.aggregate;
  const out = [];
  out.push('');
  out.push(`${C.bold}This week${C.reset} ${C.dim}${weekKey(Date.now())}${C.reset}    ${C.green}${v.weekHours}${C.reset} ${C.dim}active${C.reset}`);
  out.push('');
  out.push(`${C.dim}prompts${C.reset}     ${C.yellow}${String(v.weekPrompts).padStart(8)}${C.reset}`);
  out.push(`${C.dim}tool calls${C.reset}  ${C.yellow}${v.weekToolsFmt.padStart(8)}${C.reset}`);
  out.push(`${C.dim}sessions${C.reset}    ${C.cyan}${String(v.weekSessions).padStart(8)}${C.reset}`);
  out.push(`${C.dim}tokens${C.reset}      ${C.bold}${v.weekTokensFmt.padStart(8)}${C.reset}`);
  if (agg.byDay) {
    out.push('');
    out.push(`${C.dim}daily breakdown${C.reset}`);
    const { days, maxMs } = weekGrid(agg.byDay);
    for (const { label, ms, isFuture, isToday } of days) {
      if (isFuture) {
        out.push(`${C.dim}${label.padEnd(11)}${' '.repeat(18)}     —${C.reset}`);
      } else {
        const h = ms / 3_600_000;
        const hStr = h < 1 ? `${Math.round(h * 60)}m` : (h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`);
        const prefix = isToday ? C.bold : '';
        const peak = ms === maxMs && ms > 0 ? ` ${C.bold}${heat(1)}◆${C.reset}` : '';
        out.push(`${prefix}${label.padEnd(11)}${C.reset} ${bar(ms, maxMs, 18)} ${C.cyan}${hStr.padStart(5)}${C.reset}${peak}${isToday ? `  ${C.dim}← today${C.reset}` : ''}`);
      }
    }
  }
  return out;
}

function tabStreak(_, data) {
  const v = data.vars;
  const out = [];
  out.push('');
  out.push(`${C.bold}${C.magenta}${v.streak}${C.reset} ${C.dim}day streak${C.reset}    ${C.dim}longest${C.reset} ${C.cyan}${v.longestStreak}${C.reset}`);
  out.push('');
  out.push(`${C.dim}days on Claude${C.reset}    ${C.cyan}${String(v.daysSinceFirst).padStart(8)}${C.reset}`);
  if (v.bestDayDate) {
    out.push('');
    out.push(`${C.dim}best day${C.reset}          ${C.bold}${v.bestDayHours}${C.reset} ${C.dim}on ${v.bestDayDate}${C.reset}`);
    out.push(`                  ${C.dim}${v.bestDayPrompts} prompts · ${v.bestDayTokensFmt} tokens${C.reset}`);
  }
  if (v.peakHour) {
    out.push('');
    out.push(`${C.dim}peak hour${C.reset}         ${C.bold}${v.peakHour}${C.reset}   ${C.dim}${v.peakHourActiveLabel}${C.reset}`);
  }
  if (v.topEditedFile) {
    out.push('');
    out.push(`${C.dim}hotspot${C.reset}           ${C.bold}${v.topEditedFile}${C.reset}   ${C.dim}${v.topEditedCountLabel}${C.reset}`);
  }
  return out;
}

function tabLifetime(_, data) {
  const v = data.vars;
  const agg = data.aggregate;
  const out = [];
  out.push('');
  out.push(`${C.bold}All-time${C.reset}    ${C.green}${v.allHours}${C.reset} ${C.dim}active · ${v.allWallHours} wall${C.reset}`);
  out.push('');
  out.push(`${C.dim}sessions${C.reset}    ${C.yellow}${String(v.allSessions).padStart(8)}${C.reset} ${C.dim}(+${v.allSubagentRuns} subagent runs)${C.reset}`);
  out.push(`${C.dim}prompts${C.reset}     ${C.yellow}${v.allMessagesFmt.padStart(8)}${C.reset}`);
  out.push(`${C.dim}tool calls${C.reset}  ${C.yellow}${v.allToolsFmt.padStart(8)}${C.reset}`);
  out.push(`${C.dim}files${C.reset}       ${C.cyan}${v.allFilesFmt.padStart(8)}${C.reset}`);
  out.push(`${C.dim}tokens${C.reset}      ${C.bold}${C.magenta}${v.allTokensFmt.padStart(8)}${C.reset} ${C.dim}grand total${C.reset}`);
  out.push(`              ${C.dim}${v.allInputTokens} in · ${v.allOutputTokens} out · ${v.allCacheTokens} cache${C.reset}`);
  const projects = agg.projects || {};
  const top = Object.entries(projects)
    .sort((a, b) => b[1].activeMs - a[1].activeMs)
    .slice(0, 4);
  if (top.length) {
    out.push('');
    out.push(`${C.dim}top projects${C.reset}`);
    const maxMs = top[0][1].activeMs;
    for (const [name, p] of top) {
      const h = p.activeMs / 3_600_000;
      const hStr = h < 1 ? `${Math.round(h * 60)}m` : (h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`);
      const pretty = humanProject(name).slice(0, 18).padEnd(20);
      out.push(`${pretty} ${bar(p.activeMs, maxMs, 16)} ${C.cyan}${hStr.padStart(5)}${C.reset}`);
    }
  }
  return out;
}

function tabCost(_, data) {
  const v = data.vars;
  const agg = data.aggregate;
  const out = [];
  out.push('');
  out.push(`${C.bold}Estimated cost${C.reset}    ${C.green}${v.allCostFmt}${C.reset} ${C.dim}all-time · approximate${C.reset}`);
  out.push('');
  out.push(`${C.dim}today${C.reset}       ${C.cyan}${v.todayCostFmt.padStart(10)}${C.reset}`);
  out.push(`${C.dim}this week${C.reset}   ${C.cyan}${v.weekCostFmt.padStart(10)}${C.reset}`);
  out.push(`${C.dim}this project${C.reset} ${C.cyan}${v.projectCostFmt.padStart(10)}${C.reset}`);

  const byModel = Object.entries(agg.costByModel || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (byModel.length) {
    out.push('');
    out.push(`${C.dim}by model${C.reset}`);
    const max = byModel[0][1];
    for (const [m, val] of byModel) {
      const pretty = String(m).padEnd(20);
      out.push(`${pretty} ${bar(val, max, 18)} ${C.cyan}${fmtCost(val).padStart(8)}${C.reset}`);
    }
  }

  // Month-to-date forecast.
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let mtd = 0;
  for (const [k, day] of Object.entries(agg.byDay || {})) {
    if (k.startsWith(ym)) mtd += day.cost || 0;
  }
  if (mtd > 0) {
    const daysIn = now.getDate();
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const forecast = (mtd / daysIn) * daysInMonth;
    out.push('');
    out.push(`${C.dim}month-to-date${C.reset} ${C.cyan}${fmtCost(mtd).padStart(8)}${C.reset}`);
    out.push(`${C.dim}forecast${C.reset}      ${C.bold}${fmtCost(forecast).padStart(8)}${C.reset}`);
  }
  return out;
}

function tabCode(_, data) {
  const v = data.vars;
  const agg = data.aggregate;
  const out = [];
  out.push('');
  out.push(`${C.bold}Code churn${C.reset}    ${C.green}+${v.linesAddedFmt}${C.reset} / ${C.red}−${v.linesRemovedFmt}${C.reset}  ${C.dim}net ${v.linesNetFmt}${C.reset}`);
  out.push('');
  out.push(`${C.dim}today${C.reset}    ${C.green}+${v.todayLinesAddedFmt}${C.reset}  ${C.dim}(${v.todayLinesNetFmt} net)${C.reset}`);
  out.push(`${C.dim}this week${C.reset} ${C.green}+${v.weekLinesAddedFmt}${C.reset}  ${C.dim}(${v.weekLinesNetFmt} net)${C.reset}`);

  const langs = Object.entries(agg.languages || {}).sort((a, b) => (b[1].edits || 0) - (a[1].edits || 0)).slice(0, 6);
  if (langs.length) {
    out.push('');
    out.push(`${C.dim}languages · by edits${C.reset}`);
    const max = langs[0][1].edits || 1;
    for (const [name, l] of langs) {
      const pretty = name.slice(0, 18).padEnd(20);
      out.push(`${pretty} ${bar(l.edits, max, 18)} ${C.cyan}${String(l.edits).padStart(6)}${C.reset}`);
    }
  }

  const bash = Object.entries(agg.bashCommands || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (bash.length) {
    out.push('');
    out.push(`${C.dim}top bash${C.reset}`);
    for (const [k, n] of bash) {
      out.push(`${k.padEnd(20)} ${C.cyan}${String(n).padStart(6)}${C.reset}`);
    }
  }
  return out;
}

const TAB_RENDERERS = [tabNow, tabToday, tabWeek, tabStreak, tabLifetime, tabCost, tabCode];

// ── Render ──────────────────────────────────────────────────────────────────
function render() {
  const w = width();
  const h = height();
  const data = loadSnapshot();

  const header = drawHeader(w);
  const footer = drawFooter(w);
  const body = indent(TAB_RENDERERS[currentTab](w, data));

  // Pad body so footer sits at bottom of viewport.
  const available = h - header.length - footer.length - 1; // -1 for safety
  while (body.length < available) body.push('');
  if (body.length > available) body.length = available;

  process.stdout.write(CLEAR + [...header, ...body, ...footer].join('\n'));
}

// ── Input / lifecycle ───────────────────────────────────────────────────────
function cleanup() {
  if (exiting) return;
  exiting = true;
  if (refreshTimer) clearInterval(refreshTimer);
  try { process.stdin.setRawMode(false); } catch { /* not a tty (CI, pipe) — no-op */ }
  process.stdin.pause();
  process.stdout.write(SHOW_CURSOR + CLEAR + '\n');
  process.exit(0);
}

function handleKey(buf) {
  const key = buf.toString();
  if (key === '\x03' || key.toLowerCase() === 'q') return cleanup();
  if (key.toLowerCase() === 'r') return render();
  if (key.length === 1 && key >= '1' && key <= String(TABS.length)) {
    currentTab = Number(key) - 1;
    return render();
  }
  if (key === '\x1b[C' || key === '\x1b[B' || key === '\t' || key === 'l' || key === 'j') {
    currentTab = (currentTab + 1) % TABS.length;
    return render();
  }
  if (key === '\x1b[D' || key === '\x1b[A' || key === 'h' || key === 'k') {
    currentTab = (currentTab - 1 + TABS.length) % TABS.length;
    return render();
  }
}

export function startTui() {
  if (!process.stdout.isTTY) {
    console.error('claude-rpc status: not a TTY. Use `claude-rpc status --dump` for plain output.');
    process.exit(1);
  }
  process.stdout.write(HIDE_CURSOR);

  try { process.stdin.setRawMode(true); } catch { /* not a tty — TUI will print once and exit */ }
  process.stdin.resume();
  process.stdin.on('data', handleKey);

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
  process.on('exit', () => {
    try { process.stdin.setRawMode(false); } catch { /* not a tty (CI, pipe) — no-op */ }
    process.stdout.write(SHOW_CURSOR);
  });
  process.stdout.on('resize', () => render());

  refreshTimer = setInterval(render, 3000);
  render();
}
