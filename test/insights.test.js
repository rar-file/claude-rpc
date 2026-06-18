// generateInsights — the auto-generated lines shown in the TUI, web
// dashboard, and `claude-rpc insights` output. The pure function over
// aggregate.json doesn't need a fixture file; we feed it shaped data
// and assert the lines we expect.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { generateInsights } = await import('../src/insights.js');

test('generateInsights: empty aggregate yields the not-enough-data line', () => {
  const lines = generateInsights({});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Not enough data/);
});

test('generateInsights: byDay → trend line', () => {
  // Two windows of activity, +66% jump week-over-week.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayKey = (offset) => {
    const d = new Date(today);
    d.setDate(d.getDate() - offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const byDay = {};
  for (let i = 0; i < 7; i++) byDay[dayKey(i)] = { activeMs: 5 * 3_600_000 };       // 35h this week
  for (let i = 7; i < 14; i++) byDay[dayKey(i)] = { activeMs: 3 * 3_600_000 };      // 21h last week
  const lines = generateInsights({ byDay });
  const trend = lines.find((l) => /above last week|below last week|Steady week|Fresh momentum/.test(l));
  assert.ok(trend, 'a trend line is emitted');
});

test('generateInsights: streak ≥ 3 produces a streak progress line', () => {
  const byDay = { '2026-05-20': { activeMs: 60_000 } };
  const lines = generateInsights({
    byDay,
    streak: 5,
    targets: undefined,
  });
  const streakLine = lines.find((l) => /streak/i.test(l));
  assert.ok(streakLine, 'streak line emitted at streak ≥ 3');
});

test('generateInsights: limit option caps output', () => {
  const byDay = { '2026-05-20': { activeMs: 60_000 } };
  const lines = generateInsights({
    byDay,
    streak: 5,
    languages: { TypeScript: { edits: 100, files: 10 } },
    topEditedFiles: [{ path: '/x/index.html', count: 12 }],
    byWeekday: { 2: { activeMs: 3 * 3_600_000 } },
    estimatedCost: 5,
  }, { limit: 2 });
  assert.ok(lines.length <= 2);
});

// ── rotation + the expanded generator set ───────────────────────────────

const H = 3_600_000;
function richAgg() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dk = (o) => {
    const d = new Date(today); d.setDate(d.getDate() - o);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const byDay = {};
  for (let i = 0; i < 7; i++) byDay[dk(i)] = { activeMs: 5 * H, cost: 5 };
  for (let i = 7; i < 14; i++) byDay[dk(i)] = { activeMs: 3 * H };
  return {
    byDay,
    byHour: { 2: { activeMs: 10 * H }, 3: { activeMs: 8 * H }, 14: { activeMs: 1 * H } },
    peakHour: { hour: 2 },
    bestDay: { day: dk(0), activeMs: 6 * H, linesAdded: 3000 },
    byWeekday: { 0: { activeMs: 1 * H }, 1: { activeMs: 5 * H }, 2: { activeMs: 6 * H }, 6: { activeMs: 1 * H } },
    streak: 10, longestStreak: 10, daysSinceFirst: 32,
    linesAdded: 95_000, uniqueFiles: 1167, sessions: 77,
    languages: { JavaScript: { edits: 2300, files: 297 } },
    projects: { 'claude-rpc': { activeMs: 39 * H, sessions: 30 }, other: { activeMs: 1e6, sessions: 1 } },
    toolBreakdown: { Bash: 5441, Read: 3419 },
    bashCommands: { gh: 175 },
    modelSplit: [{ model: 'opus-4-8', tokenPct: 0.64 }, { model: 'fable-5', tokenPct: 0.2 }, { model: 'haiku-4-5', tokenPct: 0.1 }],
    subagentRuns: 420, subagents: { Explore: 200 },
    inputTokens: 3e6, outputTokens: 9e6, cacheReadTokens: 2e9, cacheWriteTokens: 5e7,
    notifications: 505, estimatedCost: 1862,
    webDomains: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`d${i}.com`, 1])),
  };
}

test('generateInsights: rich aggregate yields a deep, varied pool', () => {
  const pool = generateInsights(richAgg(), { seed: 1, limit: 99 });
  assert.ok(pool.length >= 12, `expected a deep pool, got ${pool.length}`);
});

test('generateInsights: surfaces the new signal types', () => {
  const all = generateInsights(richAgg(), { seed: 1, limit: 99 }).join('\n');
  assert.match(all, /Night owl/, 'chronotype from byHour/peakHour');
  assert.match(all, /New personal best/, 'bestDay set today');
  assert.match(all, /pages of a paperback/, 'lines → book pages');
  assert.match(all, /from cache/, 'cache efficiency');
  assert.match(all, /claude-rpc|worked across \d+ projects/, 'project signal (either form)');
});

test('generateInsights: model name is prettified (opus-4-8 → Opus 4.8)', () => {
  const byDay = { '2026-05-20': { activeMs: 60_000 } };
  const all = generateInsights({ byDay, modelSplit: [{ model: 'opus-4-8', tokenPct: 0.7 }] }, { seed: 1, limit: 99 });
  assert.ok(all.some((l) => /Opus 4\.8 does most/.test(l)), 'prettified single-model line present');
});

test('generateInsights: same seed is deterministic; topic dedup prevents twin streak lines', () => {
  const a1 = generateInsights(richAgg(), { seed: 5 });
  const a2 = generateInsights(richAgg(), { seed: 5 });
  assert.deepEqual(a1, a2, 'a fixed seed reproduces the same order');
  const streakLines = generateInsights(richAgg(), { seed: 5, limit: 99 }).filter((l) => /streak/i.test(l));
  assert.ok(streakLines.length <= 1, `at most one streak line, got ${streakLines.length}`);
});

test('generateInsights: different seeds surface different mixes', () => {
  const sets = [1, 2, 3, 4, 5].map((s) => generateInsights(richAgg(), { seed: s }).join('|'));
  assert.ok(new Set(sets).size >= 2, 'rotation produces more than one distinct top-5');
});
