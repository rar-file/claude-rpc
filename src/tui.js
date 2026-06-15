// Interactive terminal dashboard — full-screen framed panels, keyboard tabs,
// live refresh. Uses the alternate screen buffer (restored on quit) and box
// drawing, so it targets modern terminals (Windows Terminal, iTerm, kitty,
// etc.). NO_COLOR is honored: color drops out, the box structure stays.
//
// renderFrame() is pure (data in → string out) so the layout is testable and
// previewable without a live TTY; startTui() owns the IO/loop.

import process from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { readActiveState } from './state.js';
import { readAggregate, findLiveSessions, dayKey } from './scanner.js';
import { buildVars, applyIdle, humanProject, fmtNum } from './format.js';
import { loadConfig } from './config.js';
import { PID_PATH } from './paths.js';
import { fmtCost } from './pricing.js';
import { heat } from './ui.js';

// ── ANSI ────────────────────────────────────────────────────────────────────
const ESC = '\x1b[';
const CLEAR = ESC + '2J' + ESC + 'H';
const HIDE_CURSOR = ESC + '?25l';
const SHOW_CURSOR = ESC + '?25h';
const ALT_ON = ESC + '?1049h';   // alternate screen buffer — restored on quit
const ALT_OFF = ESC + '?1049l';

// Color drops out entirely under NO_COLOR; box-drawing (not color) stays.
const COLOR = !process.env.NO_COLOR;
const sgr = (code) => (COLOR ? ESC + code : '');
const C = {
  reset:   sgr('0m'),
  dim:     sgr('2m'),
  bold:    sgr('1m'),
  red:     sgr('31m'),
  green:   sgr('32m'),
  yellow:  sgr('33m'),
  magenta: sgr('35m'),
  cyan:    sgr('36m'),
  gray:    sgr('90m'),
};
const ansiRe = /\x1b\[[0-9;]*m/g;
const visLen = (s) => String(s).replace(ansiRe, '').length;

// Box-drawing — rounded corners for the "serious" look.
const BX = { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', sl: '├', sr: '┤' };

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

// ── Width-aware string helpers ────────────────────────────────────────────────
// Truncate/pad a (possibly ANSI-coloured) string to exactly `w` visible columns.
// Padding resets colour first so trailing spaces never inherit a fill; truncation
// appends an ellipsis and a reset so colour can't bleed past the cut.
function fit(s, w) {
  s = String(s);
  const len = visLen(s);
  if (len === w) return s;
  if (len < w) return s + C.reset + ' '.repeat(w - len);
  let out = '', vis = 0, i = 0;
  while (i < s.length && vis < w - 1) {
    if (s[i] === '\x1b') {
      const m = s.indexOf('m', i);
      if (m !== -1) { out += s.slice(i, m + 1); i = m + 1; continue; }
    }
    out += s[i]; vis++; i++;
  }
  return out + '…' + C.reset;
}

// Heat-graded fill bar. `ratio` in 0..1 (or value/max). NO_COLOR-safe via heat().
function bar(ratio, w) {
  const r = Math.max(0, Math.min(1, ratio || 0));
  const filled = Math.max(0, Math.min(w, Math.round(r * w)));
  return `${heat(r)}${'█'.repeat(filled)}${C.reset}${' '.repeat(w - filled)}`;
}

// ── Panels & columns ──────────────────────────────────────────────────────────
// A bordered panel of exact total width `w`, title embedded in the top border.
// Returns an array of lines (height = body.length + 2).
function panel(title, body, w) {
  const out = [];
  if (title) {
    const fill = Math.max(0, w - 5 - visLen(title));
    out.push(`${C.gray}${BX.tl}${BX.h} ${C.bold}${title}${C.reset}${C.gray} ${BX.h.repeat(fill)}${BX.tr}${C.reset}`);
  } else {
    out.push(`${C.gray}${BX.tl}${BX.h.repeat(w - 2)}${BX.tr}${C.reset}`);
  }
  for (const line of body) {
    out.push(`${C.gray}${BX.v}${C.reset} ${fit(line, w - 4)} ${C.gray}${BX.v}${C.reset}`);
  }
  out.push(`${C.gray}${BX.bl}${BX.h.repeat(w - 2)}${BX.br}${C.reset}`);
  return out;
}

// Lay panel arrays side by side, padding shorter ones with blanks of their width.
function columns(panels, gap = 3) {
  const hgt = Math.max(...panels.map((p) => p.length));
  const ws = panels.map((p) => visLen(p[0] || ''));
  const spacer = ' '.repeat(gap);
  const out = [];
  for (let i = 0; i < hgt; i++) {
    out.push(panels.map((p, j) => (p[i] !== undefined ? p[i] : ' '.repeat(ws[j]))).join(spacer));
  }
  return out;
}

// Split a content width into two column widths (with a gap between).
function split2(cw, gap = 3) {
  const tot = cw - gap;
  const l = Math.floor(tot / 2);
  return [l, tot - l];
}

// "label ............ value" justified to width `w` (panel content width).
function statRows(pairs, w) {
  return pairs.map(([label, val]) => {
    const pad = Math.max(1, w - visLen(label) - visLen(val));
    return `${C.dim}${label}${C.reset}${' '.repeat(pad)}${val}`;
  });
}

// "name  ████████  value" justified to width `w` (panel content width).
function barRow(label, valStr, ratio, w) {
  const labelW = Math.max(8, Math.min(16, Math.floor(w * 0.42)));
  const valW = Math.max(5, Math.min(11, visLen(valStr)));
  const barW = Math.max(3, w - labelW - valW - 2);
  const name = String(label).length > labelW ? String(label).slice(0, labelW - 1) + '…' : String(label).padEnd(labelW);
  return `${C.dim}${name}${C.reset} ${bar(ratio, barW)} ${C.cyan}${valStr.padStart(valW)}${C.reset}`;
}

function hms(ms) {
  const h = (ms || 0) / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m`;
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
}

function statusColor(s) {
  return s === 'working' ? C.green
    : s === 'thinking' ? C.yellow
    : s === 'notification' ? C.magenta
    : s === 'shipped' ? C.green
    : s === 'stale' ? C.dim
    : C.cyan;
}

function headline(title, value, sub) {
  const v = value ? `   ${C.bold}${C.cyan}${value}${C.reset}` : '';
  const s = sub ? `   ${C.dim}${sub}${C.reset}` : '';
  return [`${C.bold}${title.toUpperCase()}${C.reset}${v}${s}`, ''];
}

// ── Data ──────────────────────────────────────────────────────────────────────
export function loadSnapshot() {
  let state = readActiveState();
  state.liveSessions = findLiveSessions({ thresholdMs: 90_000 });
  const config = loadConfig();
  state = applyIdle(state, config);
  const aggregate = readAggregate() || {};
  const vars = buildVars(state, config, aggregate);
  return { state, config, aggregate, vars, pid: daemonPid() };
}

function daemonPid() {
  if (!existsSync(PID_PATH)) return null;
  try {
    const pid = Number(readFileSync(PID_PATH, 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch { return null; }
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Rolling last-7-days window (today + the 6 prior days), summed from byDay.
// Anchored at local noon so a day subtraction can't slip across a DST boundary.
function last7Days(byDay = {}) {
  const days = [];
  let totMs = 0, prompts = 0, tools = 0, sessions = 0, tokens = 0, cost = 0;
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
    const key = dayKey(d.getTime());
    const e = byDay[key] || {};
    const ms = e.activeMs || 0;
    days.push({ label: `${WD[d.getDay()]} ${key.slice(5)}`, ms, isToday: i === 0 });
    totMs += ms; prompts += e.userMessages || 0; tools += e.toolCalls || 0; sessions += e.sessions || 0;
    tokens += (e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheReadTokens || 0) + (e.cacheWriteTokens || 0);
    cost += e.cost || 0;
  }
  return { days, maxMs: Math.max(0, ...days.map((d) => d.ms)), totMs, prompts, tools, sessions, tokens, cost };
}

// ── Tab renderers — each returns content lines (row() fits them to width) ──────
function tabNow(data, cw) {
  const v = data.vars;
  const sc = statusColor(v.status);
  const head = [
    `${C.bold}${sc}${String(v.statusVerbose).toUpperCase()}${C.reset}  ${C.dim}in${C.reset}  ${C.bold}${v.project}${C.reset}`,
    `${C.dim}${v.modelPretty} · ${v.duration} elapsed${C.reset}`,
    '',
  ];
  const [lw, rw] = split2(cw);
  const session = panel('session', statRows([
    ['prompts', `${C.yellow}${v.messages}${C.reset}`],
    ['tool calls', `${C.yellow}${v.tools}${C.reset}`],
    ['files', `${C.cyan}${v.filesOpened}${C.reset} ${C.dim}open · ${v.filesEdited} edit · ${v.filesRead} read${C.reset}`],
    ['tokens', `${C.bold}${v.tokensFmt}${C.reset}`],
    ['', `${C.dim}${v.inputTokens} in · ${v.outputTokens} out · ${v.cacheTokens} cache${C.reset}`],
  ], lw - 4), lw);
  const liveBody = [];
  if (v.currentTool) liveBody.push(...statRows([['doing', `${C.bold}${v.currentToolPretty}${C.reset}`]], rw - 4));
  if (v.currentFilePretty) liveBody.push(`${C.dim}file${C.reset}  ${C.cyan}${v.currentFilePretty}${C.reset}`);
  liveBody.push(...statRows([['model', `${C.bold}${v.modelPretty}${C.reset}`]], rw - 4));
  if (Number(v.concurrent) > 1) {
    liveBody.push('');
    liveBody.push(`${C.magenta}${v.concurrentLabel}${C.reset}`);
    liveBody.push(`${C.dim}${v.concurrentListPretty}${C.reset}`);
  } else {
    liveBody.push(`${C.dim}single session${C.reset}`);
  }
  return [...head, ...columns([session, panel('live', liveBody, rw)])];
}

function tabToday(data, cw) {
  const v = data.vars;
  const agg = data.aggregate;
  const head = headline('today', v.todayHours, 'active');
  const [lw, rw] = split2(cw);
  const stats = panel('today', statRows([
    ['prompts', `${C.yellow}${v.todayPrompts}${C.reset}`],
    ['tool calls', `${C.yellow}${v.todayToolsFmt}${C.reset}`],
    ['sessions', `${C.cyan}${v.todaySessions}${C.reset}`],
    ['spend', `${C.green}${v.todayCostFmt}${C.reset}`],
  ], lw - 4), lw);
  const toks = panel('tokens', statRows([
    ['total', `${C.bold}${v.todayTokensFmt}${C.reset}`],
    ['fresh', `${C.cyan}${v.todayTokensRealFmt}${C.reset}`],
    ['cache', `${C.dim}${v.todayCacheTokensFmt}${C.reset}`],
    ['lines', `${C.green}+${v.todayLinesAddedFmt}${C.reset} ${C.dim}(${v.todayLinesNetFmt} net)${C.reset}`],
  ], rw - 4), rw);
  const out = [...head, ...columns([stats, toks])];

  // Full-width hour-of-day histogram.
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
    // Two cells per hour so the 24h strip reads wide.
    out.push('');
    out.push(...panel('when you code · hour of day', [
      bars.map((b) => b + b).join(''),
      `${C.dim}00    03    06    09    12    15    18    21${C.reset}`,
    ], cw));
  }
  return out;
}

function tabWeek(data, cw) {
  const agg = data.aggregate;
  const wk = last7Days(agg.byDay || {});
  const head = headline('last 7 days', hms(wk.totMs), 'active');
  const [lw, rw] = split2(cw);

  const cwBody = lw - 4;
  const dailyBody = wk.days.map(({ label, ms, isToday }) => {
    const marker = isToday ? `${C.bold}${C.cyan} ‹today${C.reset}` : '';
    const lbl = isToday ? `${C.bold}${label}${C.reset}` : `${C.dim}${label}${C.reset}`;
    // Reserve room for the value (1 space + 5) and, on today's row, the marker
    // (' ‹today' = 7) so the bar never pushes the value off the panel edge.
    const barW = Math.max(3, cwBody - 11 - 6 - (isToday ? 7 : 0));
    return `${lbl}${' '.repeat(Math.max(1, 11 - visLen(label)))}${bar(wk.maxMs ? ms / wk.maxMs : 0, barW)} ${C.cyan}${hms(ms).padStart(5)}${C.reset}${marker}`;
  });
  const daily = panel('daily', dailyBody, lw);

  const totals = panel('last 7 days', statRows([
    ['active', `${C.green}${hms(wk.totMs)}${C.reset}`],
    ['prompts', `${C.yellow}${fmtNum(wk.prompts)}${C.reset}`],
    ['tool calls', `${C.yellow}${fmtNum(wk.tools)}${C.reset}`],
    ['sessions', `${C.cyan}${fmtNum(wk.sessions)}${C.reset}`],
    ['tokens', `${C.bold}${fmtNum(wk.tokens)}${C.reset}`],
    ['spend', `${C.green}${fmtCost(wk.cost)}${C.reset}`],
  ], rw - 4), rw);

  return [...head, ...columns([daily, totals])];
}

function tabStreak(data, cw) {
  const v = data.vars;
  const [lw, rw] = split2(cw);
  const head = headline('streak', `${v.streak}d`, `longest ${v.longestStreak}d`);
  const left = panel('streak', statRows([
    ['current', `${C.bold}${C.magenta}${v.streak}${C.reset} ${C.dim}days${C.reset}`],
    ['longest', `${C.cyan}${v.longestStreak}${C.reset} ${C.dim}days${C.reset}`],
    ['days on Claude', `${C.cyan}${v.daysSinceFirst}${C.reset}`],
  ], lw - 4), lw);
  const rb = [];
  if (v.bestDayDate) rb.push(...statRows([['best day', `${C.bold}${v.bestDayHours}${C.reset} ${C.dim}${v.bestDayDate}${C.reset}`]], rw - 4));
  if (v.bestDayDate) rb.push(`${C.dim}${v.bestDayPrompts} prompts · ${v.bestDayTokensFmt} tokens${C.reset}`);
  if (v.peakHour) rb.push(...statRows([['peak hour', `${C.bold}${v.peakHour}${C.reset} ${C.dim}${v.peakHourActiveLabel}${C.reset}`]], rw - 4));
  if (v.topEditedFile) rb.push(...statRows([['hotspot', `${C.bold}${v.topEditedFile}${C.reset}`]], rw - 4));
  if (!rb.length) rb.push(`${C.dim}keep going to unlock records${C.reset}`);
  return [...head, ...columns([left, panel('records', rb, rw)])];
}

function tabLifetime(data, cw) {
  const v = data.vars;
  const agg = data.aggregate;
  const [lw, rw] = split2(cw);
  const head = headline('all-time', v.allHours, `active · ${v.allWallHours} wall`);
  const stats = panel('all-time', statRows([
    ['sessions', `${C.yellow}${v.allSessions}${C.reset} ${C.dim}+${v.allSubagentRuns} sub${C.reset}`],
    ['prompts', `${C.yellow}${v.allMessagesFmt}${C.reset}`],
    ['tool calls', `${C.yellow}${v.allToolsFmt}${C.reset}`],
    ['files', `${C.cyan}${v.allFilesFmt}${C.reset}`],
    ['tokens', `${C.bold}${C.magenta}${v.allTokensFmt}${C.reset}`],
    ['spend', `${C.green}${v.allCostFmt}${C.reset}`],
  ], lw - 4), lw);
  const top = Object.entries(agg.projects || {}).sort((a, b) => b[1].activeMs - a[1].activeMs).slice(0, 6);
  const maxMs = top[0] ? top[0][1].activeMs : 1;
  const projBody = top.length
    ? top.map(([name, p]) => barRow(humanProject(name), hms(p.activeMs), p.activeMs / maxMs, rw - 4))
    : [`${C.dim}no projects yet${C.reset}`];
  return [...head, ...columns([stats, panel('top projects · by time', projBody, rw)])];
}

function tabCost(data, cw) {
  const v = data.vars;
  const agg = data.aggregate;
  const [lw, rw] = split2(cw);
  const head = headline('spend', v.allCostFmt, 'all-time · approximate');

  // Per-project spend — the headline ask.
  const projs = Object.entries(agg.projects || {})
    .map(([k, p]) => [humanProject(k), p.cost || 0]).filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxP = projs[0] ? projs[0][1] : 1;
  const projBody = projs.length
    ? projs.map(([name, c]) => barRow(name, fmtCost(c), c / maxP, lw - 4))
    : [`${C.dim}no spend recorded${C.reset}`];
  const byProject = panel('by project', projBody, lw);

  const models = Object.entries(agg.costByModel || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxM = models[0] ? models[0][1] : 1;
  const modelBody = models.length
    ? models.map(([m, c]) => barRow(m, fmtCost(c), c / maxM, rw - 4))
    : [`${C.dim}no model data${C.reset}`];
  const byModel = panel('by model', modelBody, rw);

  const out = [...head, ...columns([byProject, byModel])];

  // Month-to-date + forecast strip.
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let mtd = 0;
  for (const [k, day] of Object.entries(agg.byDay || {})) if (k.startsWith(ym)) mtd += day.cost || 0;
  const forecast = mtd > 0 ? (mtd / now.getDate()) * new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() : 0;
  out.push('');
  out.push(`${C.dim}today${C.reset} ${C.cyan}${v.todayCostFmt}${C.reset}   ${C.dim}week${C.reset} ${C.cyan}${v.weekCostFmt}${C.reset}   ${C.dim}month-to-date${C.reset} ${C.cyan}${fmtCost(mtd)}${C.reset}   ${C.dim}forecast${C.reset} ${C.bold}${fmtCost(forecast)}${C.reset}`);
  return out;
}

function tabCode(data, cw) {
  const v = data.vars;
  const agg = data.aggregate;
  const [lw, rw] = split2(cw);
  const head = headline('code churn', `+${v.linesAddedFmt} / −${v.linesRemovedFmt}`, `net ${v.linesNetFmt}`);
  const langs = Object.entries(agg.languages || {}).sort((a, b) => (b[1].edits || 0) - (a[1].edits || 0)).slice(0, 6);
  const maxL = langs[0] ? (langs[0][1].edits || 1) : 1;
  const langBody = [
    ...statRows([
      ['today', `${C.green}+${v.todayLinesAddedFmt}${C.reset} ${C.dim}(${v.todayLinesNetFmt} net)${C.reset}`],
      ['this week', `${C.green}+${v.weekLinesAddedFmt}${C.reset} ${C.dim}(${v.weekLinesNetFmt} net)${C.reset}`],
    ], lw - 4),
    '',
    ...(langs.length ? langs.map(([n, l]) => barRow(n, fmtNum(l.edits || 0), (l.edits || 0) / maxL, lw - 4)) : [`${C.dim}no edits yet${C.reset}`]),
  ];
  const churn = panel('languages · by edits', langBody, lw);

  const bash = Object.entries(agg.bashCommands || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const dom = Object.entries(agg.webDomains || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const rb = [];
  if (bash.length) { rb.push(`${C.dim}top bash${C.reset}`); for (const [k, n] of bash) rb.push(`${String(k).slice(0, rw - 12).padEnd(rw - 12)} ${C.cyan}${String(n).padStart(6)}${C.reset}`); }
  if (dom.length) { rb.push(''); rb.push(`${C.dim}web domains${C.reset}`); for (const [k, n] of dom) rb.push(`${String(k).slice(0, rw - 12).padEnd(rw - 12)} ${C.cyan}${String(n).padStart(6)}${C.reset}`); }
  if (!rb.length) rb.push(`${C.dim}no shell/web activity${C.reset}`);
  return [...head, ...columns([churn, panel('shell & web', rb, rw)])];
}

const TAB_RENDERERS = [tabNow, tabToday, tabWeek, tabStreak, tabLifetime, tabCost, tabCode];

// ── Frame composition ─────────────────────────────────────────────────────────
function topBorder(w, title, statusColored) {
  const fill = Math.max(0, w - title.length - visLen(statusColored) - 8);
  return `${C.gray}${BX.tl}${BX.h} ${C.bold}${title}${C.reset}${C.gray} ${BX.h.repeat(fill)} ${C.reset}${statusColored}${C.gray} ${BX.h}${BX.tr}${C.reset}`;
}
function bottomBorder(w) { return `${C.gray}${BX.bl}${BX.h.repeat(w - 2)}${BX.br}${C.reset}`; }
function sepLine(w) { return `${C.gray}${BX.sl}${BX.h.repeat(w - 2)}${BX.sr}${C.reset}`; }
function row(content, w) { return `${C.gray}${BX.v}${C.reset} ${fit(content, w - 4)} ${C.gray}${BX.v}${C.reset}`; }

export function renderFrame(data, { width, height, tab }) {
  const w = Math.max(64, Math.min(160, width || 100));
  const h = Math.max(20, height || 30);
  const cw = w - 4;

  const status = data.pid
    ? `${C.green}●${C.reset} ${C.dim}running · pid ${data.pid}${C.reset}`
    : `${C.red}○${C.reset} ${C.dim}daemon not running${C.reset}`;
  const tabBar = TABS.map((t, i) => (i === tab
    ? `${C.bold}${C.cyan}‹${t.label}›${C.reset}`
    : `${C.dim}${t.label}${C.reset}`)).join('  ');
  const footer = `${C.dim}1-7${C.reset} jump   ${C.gray}·${C.reset}   ${C.dim}←→ h l${C.reset} tab   ${C.gray}·${C.reset}   ${C.dim}r${C.reset} refresh   ${C.gray}·${C.reset}   ${C.dim}q${C.reset} quit`;

  const B = Math.max(1, h - 6); // top + tab + sep + sep + footer + bottom = 6
  const bodyContent = TAB_RENDERERS[tab](data, cw);
  const body = bodyContent.slice(0, B);
  while (body.length < B) body.push('');

  const lines = [topBorder(w, 'claude-rpc', status), row(tabBar, w), sepLine(w)];
  for (const b of body) lines.push(row(b, w));
  lines.push(sepLine(w), row(footer, w), bottomBorder(w));
  return lines.join('\n');
}

// ── Live render / input / lifecycle ───────────────────────────────────────────
function width()  { return Math.max(64, Math.min(160, process.stdout.columns || 100)); }
function height() { return Math.max(20, process.stdout.rows || 30); }

function render() {
  process.stdout.write(CLEAR + renderFrame(loadSnapshot(), { width: width(), height: height(), tab: currentTab }));
}

function cleanup() {
  if (exiting) return;
  exiting = true;
  if (refreshTimer) clearInterval(refreshTimer);
  try { process.stdin.setRawMode(false); } catch { /* not a tty (CI, pipe) — no-op */ }
  process.stdin.pause();
  process.stdout.write(SHOW_CURSOR + ALT_OFF);
  process.exit(0);
}

function handleKey(buf) {
  const key = buf.toString();
  if (key === '\x03' || key.toLowerCase() === 'q') return cleanup();
  if (key.toLowerCase() === 'r') return render();
  if (key.length === 1 && key >= '1' && key <= String(TABS.length)) { currentTab = Number(key) - 1; return render(); }
  if (key === '\x1b[C' || key === '\x1b[B' || key === '\t' || key === 'l' || key === 'j') { currentTab = (currentTab + 1) % TABS.length; return render(); }
  if (key === '\x1b[D' || key === '\x1b[A' || key === 'h' || key === 'k') { currentTab = (currentTab - 1 + TABS.length) % TABS.length; return render(); }
}

export function startTui() {
  if (!process.stdout.isTTY) {
    console.error('claude-rpc status: not a TTY. Use `claude-rpc status --dump` for plain output.');
    process.exit(1);
  }
  process.stdout.write(ALT_ON + HIDE_CURSOR);
  try { process.stdin.setRawMode(true); } catch { /* not a tty — TUI will print once and exit */ }
  process.stdin.resume();
  process.stdin.on('data', handleKey);

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
  process.on('exit', () => {
    try { process.stdin.setRawMode(false); } catch { /* not a tty (CI, pipe) — no-op */ }
    process.stdout.write(SHOW_CURSOR + ALT_OFF);
  });
  process.stdout.on('resize', () => render());

  refreshTimer = setInterval(render, 3000);
  render();
}
