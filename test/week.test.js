// weekGrid — shared Mon-anchored current-week grid used by `status --week`
// (cli.js) and the TUI week tab. Pinned against a fixed clock so the date math
// can't drift between the two renderers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weekGrid } from '../src/week.js';
import { dayKey } from '../src/scanner.js';

test('weekGrid: Mon-anchored 7 days, today/future split, maxMs floor', () => {
  const now = new Date(2026, 5, 17, 15, 0, 0); // mid-June 2026, local
  const todayKey = dayKey(now.getTime());
  const byDay = { [todayKey]: { activeMs: 7_200_000 } };
  const { days, maxMs } = weekGrid(byDay, now);

  assert.equal(days.length, 7);
  assert.ok(days[0].label.startsWith('Mon'), 'week starts Monday');
  assert.ok(days[6].label.startsWith('Sun'), 'week ends Sunday');

  const todayIdx = days.findIndex((d) => d.isToday);
  assert.ok(todayIdx >= 0, 'today is in the grid');
  assert.equal(days[todayIdx].ms, 7_200_000);
  assert.equal(days[todayIdx].isFuture, false);
  assert.equal(maxMs, 7_200_000);

  // Everything after today is future; nothing on/before today is.
  for (let i = todayIdx + 1; i < 7; i++) assert.equal(days[i].isFuture, true, `day ${i} future`);
  for (let i = 0; i <= todayIdx; i++) assert.equal(days[i].isFuture, false, `day ${i} not future`);

  // Empty byDay → maxMs floored at 1 (safe divisor for bar scaling).
  assert.equal(weekGrid({}, now).maxMs, 1);
});
