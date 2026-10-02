import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const {
  HEATMAP_DAYS, isDayKey, seriesValues, levelCutoffs, levelOf, seriesFacts,
  renderHeatmap, renderStatsCard, mergeSeries,
} = await import('../src/heatmap.js');
const { buildDailySeries, buildProfilePayload } = await import('../src/community.js');
const { dayKey } = await import('../src/scanner.js');

test('heatmap.js stays pure (the worker bundles it — no imports allowed)', () => {
  const src = readFileSync(new URL('../src/heatmap.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
});

test('isDayKey: real calendar dates only', () => {
  assert.ok(isDayKey('2026-02-28'));
  assert.ok(!isDayKey('2026-02-30'));
  assert.ok(!isDayKey('2026-2-3'));
  assert.ok(!isDayKey(20260101));
});

test('seriesValues: right-aligns a short series, pads with zeros, drops junk', () => {
  const v = seriesValues({ end: '2026-10-02', tokens: [5, -1, 'x', 7] }, 'tokens', 6);
  assert.deepEqual(v, [0, 0, 5, 0, 0, 7]);
  assert.deepEqual(seriesValues({ end: '2026-10-02', activeMin: [3] }, 'hours', 2), [0, 3]);
});

test('levelCutoffs: quartiles of non-zero days; zero is always level 0', () => {
  const cut = levelCutoffs([0, 1, 2, 3, 4, 0]);
  assert.equal(levelOf(0, cut), 0);
  assert.equal(levelOf(1, cut), 1);
  assert.equal(levelOf(4, cut), 4);
  // no activity at all → no cutoffs
  assert.deepEqual(levelCutoffs([0, 0]), [Infinity, Infinity, Infinity]);
});

test('seriesFacts: busiest day, runs, average, weekday', () => {
  // end 2026-10-02 is a Friday
  const f = seriesFacts({ end: '2026-10-02', tokens: [10, 0, 30, 20, 0] }, 'tokens', 5);
  assert.equal(f.total, 60);
  assert.equal(f.activeDays, 3);
  assert.deepEqual(f.busiest, { date: '2026-09-30', value: 30 });
  assert.equal(f.longestRun, 2);
  assert.equal(f.currentRun, 2, 'an empty TODAY does not break the current run');
  assert.equal(f.avgPerActiveDay, 20);
  assert.equal(f.bestWeekday, 'Wednesday');
});

test('mergeSeries: sums machines per date even when their ends differ', () => {
  const a = { end: '2026-10-02', tokens: [1, 2, 3], activeMin: [10, 20, 30] };
  const b = { end: '2026-10-01', tokens: [100, 200], activeMin: [1, 2] }; // Sep 30, Oct 1
  const m = mergeSeries([a, b, null, { end: 'junk', tokens: [9] }], '2026-10-02', 4);
  assert.deepEqual(m.tokens, [0, 101, 202, 3]);
  assert.deepEqual(m.activeMin, [0, 11, 22, 30]);
  assert.equal(mergeSeries([null], '2026-10-02'), null);
});

test('renderHeatmap / renderStatsCard: valid SVG, escaped names, empty states', () => {
  const series = { end: '2026-10-02', tokens: [5, 0, 9], activeMin: [1, 0, 2] };
  const h = renderHeatmap({ series, metric: 'tokens', title: '<x> & "y"' });
  assert.match(h, /^<svg /);
  assert.match(h, /&lt;x&gt; &amp; &quot;y&quot;/);
  assert.equal((h.match(/<\/rect>/g) || []).length, 52 * 7 + 6, '53 cols, last one ending on Friday');
  const card = renderStatsCard({ handle: 'a', tokens: 1e9, sessions: 3, activeMs: 3_600_000, streak: 2, verified: true }, series, { metric: 'hours' });
  assert.match(card, /1\.00B/);
  assert.match(card, /BUSIEST DAY/);
  assert.match(card, /verified/);
  assert.match(renderStatsCard(null, null), /no public profile yet/);
  assert.match(renderStatsCard({ handle: 'a' }, null), /after the next profile sync/);
});

test('buildDailySeries: local-date keyed, trims leading empties, ends today', () => {
  const now = new Date(2026, 9, 2, 15).getTime();
  const y = new Date(2026, 9, 1, 15).getTime();
  const agg = { byDay: {
    [dayKey(y)]: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, activeMs: 120_000 },
    [dayKey(now)]: { inputTokens: 1, activeMs: 0 },
    '2020-01-01': { inputTokens: 999 }, // outside the window
  } };
  const s = buildDailySeries(agg, now);
  assert.equal(s.end, dayKey(now));
  assert.deepEqual(s.tokens, [10, 1]);
  assert.deepEqual(s.activeMin, [2, 0]);
  assert.equal(buildDailySeries({}, now).tokens.length, 0);
  // a day exactly 365 days back survives trimming: the series spans 366 days
  const yearAgo = dayKey(new Date(2025, 9, 2, 12).getTime());
  assert.equal(buildDailySeries({ byDay: { [yearAgo]: { inputTokens: 1 } } }, now).tokens.length, 366);
  assert.ok(HEATMAP_DAYS >= 366);
});

test('buildProfilePayload: sends daily by default, an explicit null when profile.heatmap is false', () => {
  const agg = { byDay: {} };
  assert.ok(buildProfilePayload(agg, { handle: 'a' }, { instanceId: 'x' }).daily);
  assert.equal(buildProfilePayload(agg, { handle: 'a', heatmap: false }, { instanceId: 'x' }).daily, null, 'null clears the stored series');
});
