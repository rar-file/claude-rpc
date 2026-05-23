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
