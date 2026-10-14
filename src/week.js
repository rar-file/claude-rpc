// Monday-anchored current-week grid behind `claude-rpc week` (cli.js
// showWeek): the seven days, future/today flags, and peak — kept in its own
// module so the date math is unit-testable against a fixed clock. (The TUI's
// week tab shows a rolling last-7-days window instead; see tui.js last7Days.)

import { dayKey } from './scanner.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Returns { days: [{ label, ms, isFuture, isToday }], maxMs } for the ISO week
// (Mon -> Sun) containing `now`. `label` is e.g. "Wed 06-17"; future days have
// ms 0 and isFuture true. maxMs is floored at 1 so callers divide safely.
export function weekGrid(byDay = {}, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const todayKey = dayKey(today.getTime());
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    const k = dayKey(d.getTime());
    days.push({
      label: `${DAY_NAMES[d.getDay()]} ${k.slice(5)}`,
      ms: byDay?.[k]?.activeMs || 0,
      isFuture: d > today,
      isToday: k === todayKey,
    });
  }
  const maxMs = Math.max(...days.map((x) => x.ms)) || 1;
  return { days, maxMs };
}
