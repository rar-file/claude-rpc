// Generate 3–5 short, contextual insight lines from an aggregate.json snapshot.
// Used by `claude-rpc insights`, the web `/api/insights` route, and the TUI.
// Pure functions — no I/O, no globals beyond Date.

import { dayKey, weekKey } from './scanner.js';
import { fmtCost } from './pricing.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function fmtHours(ms) {
  if (!ms || ms < 0) return '0h';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

function fmtNum(n) {
  if (!n) return '0';
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function pct(n) {
  const sign = n >= 0 ? '+' : '−';
  return `${sign}${Math.round(Math.abs(n) * 100)}%`;
}

// Sum activeMs across the last `days` days (inclusive of today).
function windowActive(byDay, days, offset = 0) {
  let total = 0;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = offset; i < offset + days; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    total += (byDay?.[dayKey(d.getTime())] || {}).activeMs || 0;
  }
  return total;
}

export function generateInsights(aggregate, opts = {}) {
  const a = aggregate || {};
  const out = [];

  if (!a.byDay || !Object.keys(a.byDay).length) {
    return ['Not enough data yet — keep coding and check back tomorrow.'];
  }

  // 1. Trend: last 7 days vs the 7 before it.
  const last7 = windowActive(a.byDay, 7, 0);
  const prev7 = windowActive(a.byDay, 7, 7);
  if (last7 || prev7) {
    if (prev7 > 0) {
      const delta = (last7 - prev7) / prev7;
      if (Math.abs(delta) >= 0.10) {
        const dir = delta > 0 ? 'above' : 'below';
        out.push(`You're ${pct(delta)} ${dir} last week — ${fmtHours(last7)} vs ${fmtHours(prev7)}.`);
      } else {
        out.push(`Steady week — ${fmtHours(last7)} active, on par with the previous 7 days.`);
      }
    } else if (last7 > 0) {
      out.push(`Fresh momentum — ${fmtHours(last7)} active this past week.`);
    }
  }

  // 2. Peak weekday.
  if (a.byWeekday && Object.keys(a.byWeekday).length) {
    let best = null;
    for (const [wd, data] of Object.entries(a.byWeekday)) {
      if (!best || data.activeMs > best.ms) best = { wd: Number(wd), ms: data.activeMs };
    }
    if (best && best.ms > 0) {
      out.push(`Peak weekday is ${WEEKDAYS[best.wd]} — ${fmtHours(best.ms)} all-time.`);
    }
  }

  // 3. Cost pace (month-to-date forecast).
  if (a.estimatedCost && a.byDay) {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let mtd = 0;
    for (const [k, day] of Object.entries(a.byDay)) {
      if (k.startsWith(yearMonth)) mtd += day.cost || 0;
    }
    if (mtd > 0) {
      const daysIn = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const forecast = (mtd / daysIn) * daysInMonth;
      out.push(`Month-to-date estimate: ${fmtCost(mtd)} — pace projects ${fmtCost(forecast)} for the month.`);
    }
  }

  // 4. Top hotspot.
  if (a.topEditedFiles && a.topEditedFiles.length) {
    const top = a.topEditedFiles[0];
    const name = top.path.split(/[\\/]/).filter(Boolean).pop();
    out.push(`Hotspot: ${name} with ${fmtNum(top.count)} edits.`);
  }

  // 5. Streak milestone tease.
  if (a.streak >= 3) {
    const targets = [7, 14, 30, 60, 100, 365];
    const next = targets.find((t) => t > a.streak);
    if (next) {
      const remaining = next - a.streak;
      out.push(`${a.streak}-day streak — ${remaining} ${remaining === 1 ? 'day' : 'days'} to ${next}.`);
    } else {
      out.push(`${a.streak}-day streak — beyond every milestone we track. Incredible.`);
    }
  } else if (a.longestStreak >= 7) {
    out.push(`Longest streak so far: ${a.longestStreak} days. Today could start the next one.`);
  }

  // 6. Top language / framework.
  if (a.languages) {
    const top = Object.entries(a.languages).sort((x, y) => y[1].edits - x[1].edits)[0];
    if (top) {
      out.push(`Most edits land in ${top[0]} — ${fmtNum(top[1].edits)} across ${fmtNum(top[1].files)} files.`);
    }
  }

  // 7. Subagent usage (where it differs interestingly from defaults).
  if (a.subagents && Object.keys(a.subagents).length) {
    const top = Object.entries(a.subagents).sort((x, y) => y[1] - x[1])[0];
    if (top && top[1] >= 3) {
      out.push(`Favorite subagent: ${top[0]} — invoked ${top[1]} times.`);
    }
  }

  // 8. Notification frequency (only when high).
  if (a.notifications && a.notifications > 20) {
    out.push(`${a.notifications} notifications — Claude has paused for you that many times.`);
  }

  // Trim to a tidy 5 — biggest signals first (sort is already roughly priority).
  const limit = opts.limit ?? 5;
  return out.slice(0, limit);
}
