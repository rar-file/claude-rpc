// Data-shape helpers used by the dashboard's /api routes. Pure functions
// over the aggregate + state files; no HTTP concerns. Tested separately
// from the routing layer.

import { basename } from 'node:path';
import { readActiveState } from '../state.js';
import { buildVars, fillTemplate, applyIdle, framePasses, humanModel } from '../format.js';
import { readAggregate, findLiveSessions, dayKey } from '../scanner.js';
import { loadConfig as loadSharedConfig } from '../config.js';

// Re-export under the historical name so any external callers (e.g. tests
// that did `import { loadConfig } from '../api.js'`) still resolve.
// Internally everything uses the shared loader so a bad config doesn't
// blank out the dashboard with `{}` — it falls back to defaults.
export function loadConfig() {
  return loadSharedConfig();
}

export function rangeToDays(range) {
  if (range === 'all') return Infinity;
  if (range === '1y') return 365;
  const n = parseInt(range, 10);
  // Clamp to a year-and-change. windowedAggregate loops once per day, so an
  // unclamped `?range=99999999` would spin ~100M iterations and wedge the
  // single-threaded serve process — reachable from any localhost page.
  return Number.isFinite(n) && n > 0 ? Math.min(n, 366) : 90;
}

// Filter byDay to a windowed slice; also recompute roll-ups (top files etc.)
// scoped to that window. Returns a shape similar to the aggregate but trimmed.
export function windowedAggregate(agg, range) {
  if (!agg) return null;
  const days = rangeToDays(range);
  if (!Number.isFinite(days)) return agg; // 'all' → pass through

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const keepKeys = new Set();
  for (let i = 0; i < days; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    keepKeys.add(dayKey(d.getTime()));
  }

  const byDay = {};
  let activeMs = 0, prompts = 0, toolCalls = 0, lines = 0, linesRem = 0, cost = 0, sessions = 0;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0;
  for (const [k, day] of Object.entries(agg.byDay || {})) {
    if (!keepKeys.has(k)) continue;
    byDay[k] = day;
    activeMs += day.activeMs || 0;
    prompts += day.userMessages || 0;
    toolCalls += day.toolCalls || 0;
    lines += day.linesAdded || 0;
    linesRem += day.linesRemoved || 0;
    cost += day.cost || 0;
    sessions += day.sessions || 0;
    inputTokens += day.inputTokens || 0;
    outputTokens += day.outputTokens || 0;
    cacheReadTokens += day.cacheReadTokens || 0;
    cacheWriteTokens += day.cacheWriteTokens || 0;
  }

  // Prior identical window (the `days` days immediately before this one) so the
  // range card can show a "vs prior" delta like the today card does. Finite
  // windows only — the 'all' branch returned early above. Bounded (days<=366).
  let priorActiveMs = 0;
  for (let i = days; i < days * 2; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const day = (agg.byDay || {})[dayKey(d.getTime())];
    if (day) priorActiveMs += day.activeMs || 0;
  }

  return {
    range,
    byDay,
    activeMs,
    priorActiveMs,
    userMessages: prompts,
    toolCalls,
    linesAdded: lines,
    linesRemoved: linesRem,
    linesNet: lines - linesRem,
    estimatedCost: cost,
    sessions,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    grandTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    // Pass-through global keys for context.
    streak: agg.streak,
    longestStreak: agg.longestStreak,
    daysSinceFirst: agg.daysSinceFirst,
    peakHour: agg.peakHour,
    bestDay: agg.bestDay,
    projects: agg.projects || {},
    toolBreakdown: agg.toolBreakdown || {},
    topEditedFiles: agg.topEditedFiles || [],
    languages: agg.languages || {},
    bashCommands: agg.bashCommands || {},
    webDomains: agg.webDomains || {},
    subagents: agg.subagents || {},
    costByModel: agg.costByModel || {},
    modelsUsed: agg.modelsUsed || {},
    mcpToolCalls: agg.mcpToolCalls || 0,
    builtinToolCalls: agg.builtinToolCalls || 0,
    byHour: agg.byHour || {},
    byWeekday: agg.byWeekday || {},
    notifications: agg.notifications || 0,
  };
}

// Live snapshot: current state + lifetime aggregate + rendered rotation frames.
// Used by GET /api/state — the SSE 'state' event tells the client to refetch.
export function snapshot() {
  const config = loadConfig();
  const live = findLiveSessions({ thresholdMs: 90_000 });
  let state = readActiveState();
  state.liveSessions = live;
  state = applyIdle(state, config);
  const aggregate = readAggregate() || {};
  const vars = buildVars(state, config, aggregate);
  const p = config.presence || {};
  const frames = (p.rotation || []).map((f) => ({
    details: fillTemplate(f.details || '', vars),
    state: fillTemplate(f.state || '', vars),
    passes: framePasses(f, vars),
    requires: f.requires || null,
  }));
  return {
    now: Date.now(),
    state,
    aggregate: {
      sessions: aggregate.sessions,
      subagentRuns: aggregate.subagentRuns,
      userMessages: aggregate.userMessages,
      toolCalls: aggregate.toolCalls,
      uniqueFiles: aggregate.uniqueFiles,
      activeMs: aggregate.activeMs,
      wallMs: aggregate.wallMs,
      inputTokens: aggregate.inputTokens,
      outputTokens: aggregate.outputTokens,
      cacheReadTokens: aggregate.cacheReadTokens,
      cacheWriteTokens: aggregate.cacheWriteTokens,
      byDay: aggregate.byDay || {},
      byHour: aggregate.byHour || {},
      byWeekday: aggregate.byWeekday || {},
      projects: aggregate.projects || {},
      toolBreakdown: aggregate.toolBreakdown || {},
      topEditedFiles: (aggregate.topEditedFiles || []).slice(0, 12).map((e) => ({ file: basename(e.path), path: e.path, count: e.count })),
      streak: aggregate.streak,
      longestStreak: aggregate.longestStreak,
      daysSinceFirst: aggregate.daysSinceFirst,
      bestDay: aggregate.bestDay,
      peakHour: aggregate.peakHour,
      linesAdded: aggregate.linesAdded || 0,
      linesRemoved: aggregate.linesRemoved || 0,
      linesNet: aggregate.linesNet || 0,
      languages: aggregate.languages || {},
      bashCommands: aggregate.bashCommands || {},
      webDomains: aggregate.webDomains || {},
      subagents: aggregate.subagents || {},
      mcpToolCalls: aggregate.mcpToolCalls || 0,
      builtinToolCalls: aggregate.builtinToolCalls || 0,
      estimatedCost: aggregate.estimatedCost || 0,
      costByModel: aggregate.costByModel || {},
      modelsUsed: aggregate.modelsUsed || {},
      notifications: aggregate.notifications || 0,
    },
    vars,
    frames,
  };
}

// Curated payload for the animated /wrapped year-in-review page. One flat
// object the client turns into story slides — all the headline lifetime stats.
const WRAPPED_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export function wrappedData() {
  const agg = readAggregate() || {};
  const fresh = (agg.inputTokens || 0) + (agg.outputTokens || 0);
  const cache = (agg.cacheReadTokens || 0) + (agg.cacheWriteTokens || 0);
  const tokens = fresh + cache;
  const langs = Object.entries(agg.languages || {}).sort((a, b) => (b[1].edits || 0) - (a[1].edits || 0));
  const top = (agg.topEditedFiles || [])[0] || null;
  let peakWd = null;
  for (const [k, v] of Object.entries(agg.byWeekday || {})) {
    if (!peakWd || (v.activeMs || 0) > peakWd.ms) peakWd = { day: Number(k), ms: v.activeMs || 0 };
  }
  return {
    generatedAt: Date.now(),
    activeMs: agg.activeMs || 0,
    sessions: agg.sessions || 0,
    prompts: agg.userMessages || 0,
    toolCalls: agg.toolCalls || 0,
    tokens, freshTokens: fresh, cacheTokens: cache,
    cachePct: tokens > 0 ? Math.round((cache / tokens) * 100) : 0,
    streak: agg.streak || 0,
    longestStreak: agg.longestStreak || 0,
    daysSinceFirst: agg.daysSinceFirst || 0,
    topLanguage: langs[0] ? { name: langs[0][0], edits: langs[0][1].edits || 0 } : null,
    languages: langs.slice(0, 5).map(([name, v]) => ({ name, edits: v.edits || 0 })),
    hotspot: top ? { name: basename(String(top.path || '')), count: top.count, daysSinceLastEdit: top.daysSinceLastEdit } : null,
    peakHour: (Number.isInteger(agg.peakHour?.hour) && agg.peakHour.hour >= 0 && agg.peakHour.hour <= 23) ? agg.peakHour.hour : null,
    peakWeekday: peakWd ? { name: WRAPPED_WEEKDAYS[peakWd.day], hours: peakWd.ms / 3_600_000 } : null,
    modelSplit: (agg.modelSplit || []).slice(0, 4).map((m) => ({ model: humanModel(m.model) || m.model, costPct: m.costPct || 0, tokenPct: m.tokenPct || 0 })),
    linesAdded: agg.linesAdded || 0,
    linesNet: agg.linesNet ?? ((agg.linesAdded || 0) - (agg.linesRemoved || 0)),
    cost: agg.estimatedCost || 0,
    bestDay: agg.bestDay ? { date: agg.bestDay.day, hours: (agg.bestDay.activeMs || 0) / 3_600_000 } : null,
    uniqueFiles: agg.uniqueFiles || 0,
    subagentRuns: agg.subagentRuns || 0,
    notifications: agg.notifications || 0,
  };
}

export function projectDrilldown(name) {
  const agg = readAggregate() || {};
  const projects = agg.projects || {};
  const project = projects[name];
  if (!project) return null;
  return {
    name,
    ...project,
    files: (agg.topEditedFiles || []).slice(0, 25),
    tools: agg.toolBreakdown || {},
  };
}

export function dayDetail(dayKeyStr) {
  const agg = readAggregate() || {};
  const day = (agg.byDay || {})[dayKeyStr];
  if (!day) return null;
  return { day: dayKeyStr, ...day };
}

// Flatten the aggregate's byDay map into a daily-rows CSV for spreadsheet /
// pandas analysis. One row per day, sorted ascending. Date keys are
// YYYY-MM-DD and all other columns are numeric, so nothing needs quoting.
export const CSV_COLUMNS = [
  'date', 'activeMs', 'activeHours', 'sessions', 'userMessages', 'toolCalls',
  'linesAdded', 'linesRemoved', 'cost', 'inputTokens', 'outputTokens',
  'cacheReadTokens', 'cacheWriteTokens', 'notifications',
];

export function aggregateToCsv(agg) {
  const byDay = (agg && agg.byDay) || {};
  const rows = [CSV_COLUMNS.join(',')];
  for (const date of Object.keys(byDay).sort()) {
    const d = byDay[date] || {};
    const activeMs = d.activeMs || 0;
    rows.push([
      date,
      activeMs,
      (activeMs / 3_600_000).toFixed(3),
      d.sessions || 0,
      d.userMessages || 0,
      d.toolCalls || 0,
      d.linesAdded || 0,
      d.linesRemoved || 0,
      (d.cost || 0).toFixed(4),
      d.inputTokens || 0,
      d.outputTokens || 0,
      d.cacheReadTokens || 0,
      d.cacheWriteTokens || 0,
      d.notifications || 0,
    ].join(','));
  }
  return rows.join('\n') + '\n';
}
