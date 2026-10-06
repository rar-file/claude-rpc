// Standup recap — "what did I do yesterday?" answered from aggregate.json.
// Pure functions of (aggregate, range spec, now): buildRecap assembles the
// numbers, renderRecapMarkdown/renderRecapLines format them for pasting into
// a standup message or printing in the terminal. Consumed by `claude-rpc
// recap` and the MCP `get_recap` tool.
//
// Range semantics:
//   today       — the current local day
//   yesterday   — the previous local day; if it had no activity (weekend,
//                 day off), falls back to the most recent active day before
//                 today and says so — Monday standups cover Friday.
//   week        — the last 7 local days, ending today
//   YYYY-MM-DD  — one explicit local day
import { dayKey } from './scanner.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHIP_LABELS = [
  ['commit', 'commit', 'commits'],
  ['push', 'push', 'pushes'],
  ['pr', 'PR', 'PRs'],
  ['issue', 'issue', 'issues'],
  ['tag', 'release', 'releases'],
];

function fmtDur(ms) {
  const m = Math.round((ms || 0) / 60_000);
  if (m < 1) return '0m';
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function fmtN(n) {
  if (!n) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(2)}M`;
  if (n < 1e12) return `${(n / 1e9).toFixed(2)}B`;
  return `${(n / 1e12).toFixed(2)}T`;
}

function dayKeyAt(now, offsetDays) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return dayKey(d.getTime());
}

// "Tue 2026-07-01" — manual weekday names so output is locale-stable.
function prettyDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  if (!y || !m || !d) return String(key);
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${key}`;
}

// A day "has activity" when real work landed — active time, prompts, tool
// calls, sessions, or tokens. Notification-only days (the daemon logging a
// permission ping) don't count.
function hasActivity(bucket) {
  if (!bucket) return false;
  return (bucket.activeMs || 0) > 0 || (bucket.userMessages || 0) > 0
    || (bucket.toolCalls || 0) > 0 || (bucket.sessions || 0) > 0
    || (bucket.inputTokens || 0) + (bucket.outputTokens || 0)
     + (bucket.cacheReadTokens || 0) + (bucket.cacheWriteTokens || 0) > 0;
}

// Resolve a range spec to { label, days, note }. Exported for tests.
export function resolveRecapRange(spec, agg, now = Date.now()) {
  const byDay = agg?.byDay || {};
  const s = String(spec || 'yesterday').toLowerCase();
  if (s === 'today') return { label: 'today', days: [dayKeyAt(now, 0)] };
  if (s === 'week') {
    const days = [];
    for (let i = 6; i >= 0; i--) days.push(dayKeyAt(now, i));
    return { label: 'last 7 days', days };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { label: prettyDay(s), days: [s] };
  if (s !== 'yesterday') return null; // unknown spec — caller reports usage
  const yesterday = dayKeyAt(now, 1);
  if (hasActivity(byDay[yesterday])) return { label: 'yesterday', days: [yesterday] };
  // Walk back for the most recent active day before today (bounded so a
  // fresh install doesn't loop through a year of nothing).
  for (let i = 2; i <= 366; i++) {
    const k = dayKeyAt(now, i);
    if (hasActivity(byDay[k])) {
      return {
        label: 'yesterday',
        days: [k],
        note: `no activity yesterday — showing ${prettyDay(k)}, your most recent active day`,
      };
    }
  }
  return { label: 'yesterday', days: [yesterday] }; // genuinely nothing — renders as empty
}

/**
 * Assemble a recap for a range of days.
 * @param {object} agg - aggregate.json contents
 * @param {string} [spec] - today|yesterday|week|YYYY-MM-DD (default yesterday)
 * @param {number} [now] - injectable clock for tests
 * @returns {object|null} recap data, or null for an unknown spec
 */
export function buildRecap(agg, spec = 'yesterday', now = Date.now()) {
  const range = resolveRecapRange(spec, agg, now);
  if (!range) return null;
  const byDay = agg?.byDay || {};
  const r = {
    label: range.label,
    days: range.days,
    from: range.days[0],
    to: range.days[range.days.length - 1],
    note: range.note || null,
    activeMs: 0, sessions: 0, prompts: 0, toolCalls: 0,
    tokens: 0, cost: 0, linesAdded: 0, linesRemoved: 0,
    ships: 0, shipKinds: {}, projects: [],
  };
  const projects = {};
  for (const k of range.days) {
    const d = byDay[k];
    if (!d) continue;
    r.activeMs += d.activeMs || 0;
    r.sessions += d.sessions || 0;
    r.prompts += d.userMessages || 0;
    r.toolCalls += d.toolCalls || 0;
    r.tokens += (d.inputTokens || 0) + (d.outputTokens || 0) + (d.cacheReadTokens || 0) + (d.cacheWriteTokens || 0);
    r.cost += d.cost || 0;
    r.linesAdded += d.linesAdded || 0;
    r.linesRemoved += d.linesRemoved || 0;
    r.ships += d.ships || 0;
    for (const [kind, n] of Object.entries(d.shipKinds || {})) {
      r.shipKinds[kind] = (r.shipKinds[kind] || 0) + n;
    }
    for (const [name, p] of Object.entries(d.projects || {})) {
      const t = projects[name] ||= { name, activeMs: 0, tokens: 0 };
      t.activeMs += p.activeMs || 0;
      t.tokens += p.tokens || 0;
    }
  }
  r.projects = Object.values(projects)
    .sort((a, b) => (b.activeMs - a.activeMs) || (b.tokens - a.tokens) || a.name.localeCompare(b.name));
  r.empty = !(r.activeMs || r.prompts || r.toolCalls || r.sessions || r.tokens);
  return r;
}

/** Human title for a recap: "Tue 2026-07-01 (yesterday)" / "last 7 days (…)". */
export function recapTitle(r) {
  if (r.days.length > 1) return `${r.label} (${r.from} → ${r.to})`;
  const day = prettyDay(r.from);
  return r.label === 'today' || r.label === 'yesterday' ? `${day} (${r.label})` : day;
}

function shipPhrase(r) {
  const parts = [];
  for (const [kind, singular, plural] of SHIP_LABELS) {
    const n = r.shipKinds[kind] || 0;
    if (n) parts.push(`${n} ${n === 1 ? singular : plural}`);
  }
  // Counted ships whose kind map got lost (old partial data) still show up.
  if (!parts.length && r.ships) parts.push(`${r.ships}×`);
  return parts.join(' · ');
}

function projectPhrase(r, max = 6) {
  const shown = r.projects.slice(0, max)
    .map((p) => (p.activeMs >= 60_000 ? `${p.name} (${fmtDur(p.activeMs)})` : p.name));
  const extra = r.projects.length - max;
  if (extra > 0) shown.push(`+${extra} more`);
  return shown.join(', ');
}

/** Markdown recap — standup-paste-ready. */
export function renderRecapMarkdown(r) {
  const lines = [`**Claude Code recap — ${recapTitle(r)}**`, ''];
  if (r.empty) {
    lines.push(`_No Claude Code activity ${r.days.length > 1 ? 'in this range' : `on ${prettyDay(r.from)}`}._`);
    return lines.join('\n');
  }
  lines.push(`- **Active:** ${fmtDur(r.activeMs)} across ${r.sessions} session${r.sessions === 1 ? '' : 's'} · ${r.prompts} prompt${r.prompts === 1 ? '' : 's'}`);
  if (r.projects.length) lines.push(`- **Projects:** ${projectPhrase(r)}`);
  if (r.ships) lines.push(`- **Shipped:** ${shipPhrase(r)}`);
  if (r.linesAdded || r.linesRemoved) lines.push(`- **Code:** +${fmtN(r.linesAdded)} / −${fmtN(r.linesRemoved)} lines · ${fmtN(r.toolCalls)} tool calls`);
  lines.push(`- **Tokens:** ${fmtN(r.tokens)} · est. $${r.cost.toFixed(2)}`);
  if (r.note) lines.push('', `_(${r.note})_`);
  return lines.join('\n');
}

/**
 * Terminal recap — array of lines for the CLI's box renderer.
 * @param {object} r - buildRecap result
 * @param {object} [c] - optional ANSI palette ({bold, dim, cyan, green, reset, …}); omit for plain text
 */
export function renderRecapLines(r, c = {}) {
  const B = c.bold || '', D = c.dim || '', C = c.cyan || '', G = c.green || '', R = c.reset || '';
  if (r.empty) {
    const where = r.days.length > 1 ? 'in this range' : `on ${prettyDay(r.from)}`;
    return [`${D}no Claude Code activity ${where}${R}`];
  }
  const lines = [
    `${D}active${R}    ${B}${fmtDur(r.activeMs)}${R} · ${r.sessions} session${r.sessions === 1 ? '' : 's'} · ${r.prompts} prompt${r.prompts === 1 ? '' : 's'}`,
  ];
  if (r.projects.length) lines.push(`${D}projects${R}  ${C}${projectPhrase(r)}${R}`);
  if (r.ships) lines.push(`${D}shipped${R}   ${G}${shipPhrase(r)}${R}`);
  if (r.linesAdded || r.linesRemoved) lines.push(`${D}code${R}      +${fmtN(r.linesAdded)} / −${fmtN(r.linesRemoved)} lines · ${fmtN(r.toolCalls)} tool calls`);
  lines.push(`${D}tokens${R}    ${fmtN(r.tokens)} · est. $${r.cost.toFixed(2)}`);
  if (r.note) lines.push(`${D}(${r.note})${R}`);
  return lines;
}
