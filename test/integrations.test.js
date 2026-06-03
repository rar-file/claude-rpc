// v0.10 integrations: status webhook/notify decisions, MCP tool handlers,
// and the calendar / session-card SVG renderers.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { shouldWebhook, shouldNotify } = await import('../src/notify.js');
const { toolList, callTool, TOOLS } = await import('../src/mcp.js');
const { renderCalendar } = await import('../src/calendar.js');
const { renderSessionCard } = await import('../src/session-card.js');
// LOCAL-date key, matching scanner/format — see note in format.test.js.
const { dayKey } = await import('../src/scanner.js');

// ── webhook / desktop-notify decisions ────────────────────────────────
test('shouldWebhook: fires only on a configured transition', () => {
  const cfg = { url: 'https://x', on: ['shipped', 'notification'] };
  assert.equal(shouldWebhook(cfg, 'working', 'shipped'), true);
  assert.equal(shouldWebhook(cfg, 'shipped', 'shipped'), false, 'no repeat on same status');
  assert.equal(shouldWebhook(cfg, 'working', 'idle'), false, 'idle not in `on`');
  assert.equal(shouldWebhook({ url: '', on: ['shipped'] }, 'working', 'shipped'), false, 'no url → off');
});

test('shouldNotify: only on entering notification, when enabled', () => {
  assert.equal(shouldNotify({ enabled: true }, 'working', 'notification'), true);
  assert.equal(shouldNotify({ enabled: false }, 'working', 'notification'), false);
  assert.equal(shouldNotify({ enabled: true }, 'notification', 'notification'), false);
  assert.equal(shouldNotify({ enabled: true, onNotification: false }, 'working', 'notification'), false);
});

// ── MCP tool handlers ──────────────────────────────────────────────────
const AGG = {
  activeMs: 50 * 3_600_000, sessions: 90, userMessages: 600, streak: 4, longestStreak: 12,
  inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 8e6, cacheWriteTokens: 0,
  estimatedCost: 123.45, daysSinceFirst: 44,
  languages: { Python: { files: 10, edits: 579 }, JavaScript: { files: 5, edits: 100 } },
  topEditedFiles: [{ path: '/a/cli.js', count: 57, daysSinceLastEdit: 0 }],
  modelSplit: [{ model: 'opus-4-7', cost: 100, costPct: 0.9, tokens: 5e6, turns: 200 }],
  byDay: { [dayKey(Date.now())]: { activeMs: 2 * 3.6e6, userMessages: 20, toolCalls: 50, cost: 4 } },
};

test('mcp: toolList exposes the registered tools with schemas', () => {
  const names = toolList().map((t) => t.name);
  assert.deepEqual(names.sort(), Object.keys(TOOLS).sort());
  assert.ok(toolList().every((t) => t.inputSchema && t.description));
});

test('mcp: callTool returns formatted stats', () => {
  const life = callTool('get_lifetime_stats', () => AGG);
  assert.match(life, /Active time:\s+50/);
  assert.match(life, /Top language:\s+Python/);
  const today = callTool('get_today', () => AGG);
  assert.match(today, /Prompts:\s+20/);
  const files = callTool('get_top_files', () => AGG);
  assert.match(files, /cli\.js — 57 edits · today/);
  const split = callTool('get_model_split', () => AGG);
  assert.match(split, /opus-4-7.*90%/);
});

test('mcp: callTool throws on an unknown tool', () => {
  assert.throws(() => callTool('nope', () => AGG), /unknown tool/);
});

// ── SVG renderers ───────────────────────────────────────────────────────
test('renderCalendar: valid SVG with activity summary', () => {
  const svg = renderCalendar(AGG, {});
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>\s*$/);
  assert.ok(svg.includes('year on Claude Code'));
  assert.ok(svg.includes('active days'));
});

test('renderCalendar: empty aggregate does not throw', () => {
  assert.match(renderCalendar({}, {}), /^<svg /);
});

test('renderSessionCard: bakes in the session vars', () => {
  const svg = renderSessionCard({ project: 'claude-rpc', modelPretty: 'Opus 4.8', duration: '1h 48m',
    messages: 47, tools: 312, filesEdited: 9, filesRead: 14, tokensFmt: '532.0k', todayCostFmt: '$1.20' }, {});
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes('claude-rpc'));
  assert.ok(svg.includes('47'));
  assert.ok(svg.includes('532.0k'));
});

// ── wrapped payload shape (v0.11) ───────────────────────────────────────
const { wrappedData } = await import('../src/server/api.js');
test('wrappedData: returns the year-in-review payload shape', () => {
  const w = wrappedData();
  for (const k of ['activeMs', 'sessions', 'prompts', 'tokens', 'cachePct', 'streak',
    'longestStreak', 'daysSinceFirst', 'modelSplit', 'linesNet', 'cost', 'generatedAt']) {
    assert.ok(k in w, `missing key: ${k}`);
  }
  assert.ok(Array.isArray(w.modelSplit), 'modelSplit is an array');
  assert.equal(typeof w.cachePct, 'number');
});
