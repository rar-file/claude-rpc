// Recap — range resolution, totals math, renderers, and the MCP tool.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRecap, resolveRecapRange, renderRecapMarkdown, renderRecapLines, recapTitle } from '../src/recap.js';
import { callTool } from '../src/mcp.js';

// Local-noon clock so local/UTC day never splits mid-test.
const NOW = new Date(2026, 6, 2, 12, 0, 0).getTime(); // Thu 2026-07-02 local

function day(over = {}) {
  return {
    activeMs: 0, userMessages: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    sessions: 0, linesAdded: 0, linesRemoved: 0, cost: 0, notifications: 0,
    ships: 0, firstTs: null, lastTs: null, ...over,
  };
}

const AGG = {
  byDay: {
    '2026-06-28': day({ activeMs: 3_600_000, userMessages: 10, sessions: 1, inputTokens: 1000, outputTokens: 500,
      projects: { alpha: { activeMs: 3_600_000, tokens: 1500 } } }),
    // 2026-06-29..30 idle. Notifications-only day must NOT count as active:
    '2026-06-30': day({ notifications: 7 }),
    '2026-07-01': day({ activeMs: 7_200_000, userMessages: 25, toolCalls: 80, sessions: 2,
      inputTokens: 4000, outputTokens: 2000, cacheReadTokens: 100_000, linesAdded: 300, linesRemoved: 120,
      cost: 12.5, ships: 4, shipKinds: { commit: 2, push: 1, pr: 1 },
      projects: { alpha: { activeMs: 5_400_000, tokens: 90_000 }, beta: { activeMs: 1_800_000, tokens: 16_000 } } }),
  },
};

// ── resolveRecapRange ─────────────────────────────────────────────────

test('recap range: today / week / explicit date / unknown', () => {
  assert.deepEqual(resolveRecapRange('today', AGG, NOW).days, ['2026-07-02']);
  const week = resolveRecapRange('week', AGG, NOW);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0], '2026-06-26');
  assert.equal(week.days[6], '2026-07-02');
  assert.deepEqual(resolveRecapRange('2026-06-28', AGG, NOW).days, ['2026-06-28']);
  assert.equal(resolveRecapRange('fortnight', AGG, NOW), null);
});

test('recap range: yesterday with activity stays yesterday', () => {
  const r = resolveRecapRange('yesterday', AGG, NOW);
  assert.deepEqual(r.days, ['2026-07-01']);
  assert.equal(r.note, undefined);
});

test('recap range: inactive yesterday falls back to most recent active day', () => {
  // Clock on 2026-06-30: yesterday (06-29) is empty, 06-30 itself is
  // notifications-only — fall back to 06-28 and say so.
  const now = new Date(2026, 5, 30, 12).getTime();
  const r = resolveRecapRange('yesterday', AGG, now);
  assert.deepEqual(r.days, ['2026-06-28']);
  assert.match(r.note, /most recent active day/);
});

// ── buildRecap ────────────────────────────────────────────────────────

test('buildRecap: single-day totals and project ordering', () => {
  const r = buildRecap(AGG, '2026-07-01', NOW);
  assert.equal(r.activeMs, 7_200_000);
  assert.equal(r.prompts, 25);
  assert.equal(r.tokens, 106_000);
  assert.equal(r.ships, 4);
  assert.deepEqual(r.shipKinds, { commit: 2, push: 1, pr: 1 });
  assert.deepEqual(r.projects.map((p) => p.name), ['alpha', 'beta']);
  assert.equal(r.empty, false);
});

test('buildRecap: week merges days, projects, and ship kinds', () => {
  const r = buildRecap(AGG, 'week', NOW);
  assert.equal(r.sessions, 3);
  assert.equal(r.activeMs, 10_800_000);
  const alpha = r.projects.find((p) => p.name === 'alpha');
  assert.equal(alpha.activeMs, 9_000_000);
  assert.equal(alpha.tokens, 91_500);
  assert.equal(r.shipKinds.commit, 2);
});

test('buildRecap: empty day renders as empty, unknown spec is null', () => {
  const r = buildRecap(AGG, '2026-06-29', NOW);
  assert.equal(r.empty, true);
  assert.equal(buildRecap(AGG, 'nope', NOW), null);
});

// ── renderers ─────────────────────────────────────────────────────────

test('markdown recap: standup bullets with ships and projects', () => {
  const md = renderRecapMarkdown(buildRecap(AGG, '2026-07-01', NOW));
  assert.match(md, /\*\*Claude Code recap — Wed 2026-07-01\*\*/);
  assert.match(md, /\*\*Active:\*\* 2\.0h across 2 sessions · 25 prompts/);
  assert.match(md, /\*\*Projects:\*\* alpha \(1\.5h\), beta \(30m\)/);
  assert.match(md, /\*\*Shipped:\*\* 2 commits · 1 push · 1 PR/);
  assert.match(md, /\*\*Code:\*\* \+300 \/ −120 lines · 80 tool calls/);
  assert.match(md, /est\. \$12\.50/);
});

test('markdown recap: empty day says so; fallback note surfaces', () => {
  assert.match(renderRecapMarkdown(buildRecap(AGG, '2026-06-29', NOW)), /No Claude Code activity on Mon 2026-06-29/);
  const now = new Date(2026, 5, 30, 12).getTime();
  assert.match(renderRecapMarkdown(buildRecap(AGG, 'yesterday', now)), /most recent active day/);
});

test('terminal recap lines: plain palette, one line per section', () => {
  const lines = renderRecapLines(buildRecap(AGG, '2026-07-01', NOW));
  assert.equal(lines.length, 5, 'active/projects/shipped/code/tokens');
  assert.match(lines[0], /2\.0h/);
  assert.match(lines[2], /2 commits/);
});

test('recapTitle: labels ranges the way humans say them', () => {
  assert.equal(recapTitle(buildRecap(AGG, 'yesterday', NOW)), 'Wed 2026-07-01 (yesterday)');
  assert.equal(recapTitle(buildRecap(AGG, 'week', NOW)), 'last 7 days (2026-06-26 → 2026-07-02)');
});

// recap.js and mcp.js each had their own fmtN that picked the unit before
// rounding: 999_999 printed "1000.0k". Both now use fmt.js fmtNum.
test('recap + mcp: counts at a tier boundary roll over to the next unit', () => {
  const edge = { byDay: { '2026-07-01': day({ activeMs: 60_000, inputTokens: 999_999, sessions: 1 }) } };
  const md = renderRecapMarkdown(buildRecap(edge, '2026-07-01', NOW));
  assert.match(md, /Tokens:\*\* 1\.00M/);
  assert.doesNotMatch(md, /1000\.0k/);
  const life = callTool('get_lifetime_stats', () => ({ sessions: 999_999, userMessages: 999_999_999 }), {});
  assert.match(life, /Sessions:\s+1\.00M/);
  assert.match(life, /Prompts:\s+1\.00B/);
});

// ── MCP tool ──────────────────────────────────────────────────────────

test('mcp get_recap: threads the range argument and defaults to yesterday', () => {
  const out = callTool('get_recap', () => AGG, { range: 'week' });
  assert.match(out, /last 7 days/);
  const def = callTool('get_recap', () => AGG, {});
  assert.match(def, /yesterday/);
  assert.match(callTool('get_recap', () => AGG, { range: 'bogus' }), /Unknown range/);
});
