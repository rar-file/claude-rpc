// Generate short, contextual insight lines from an aggregate.json snapshot.
// Used by `claude-rpc insights`, the web `/api/insights` route, and the TUI.
// Pure functions — no I/O, no globals beyond Date.
//
// Each generator contributes 0+ candidate lines with a priority weight. The
// final pick is weight + a seeded jitter, so the strongest signals lead but the
// mid-tier ROTATES — a fresh mix each run instead of the same five forever.
// Pass opts.seed for a deterministic order (tests); it defaults to the clock.

import { dayKey } from './scanner.js';
import { fmtCost } from './pricing.js';
import { fmtNum, fmtHours } from './fmt.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pct(n) {
  const sign = n >= 0 ? '+' : '−';
  return `${sign}${Math.round(Math.abs(n) * 100)}%`;
}

// Plain thousands separator — fmtNum compacts to "1.7k", which reads oddly for
// page/file counts where the exact number is the point.
function commas(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function hourLabel(h) {
  const ampm = h < 12 ? 'am' : 'pm';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ampm}`;
}

function monthDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? `${MON[+m[2] - 1]} ${+m[3]}` : null;
}

function daysAgo(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]); d.setHours(0, 0, 0, 0);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((t - d) / 86_400_000);
}

// "opus-4-8" → "Opus 4.8", "fable-5" → "Fable 5".
function prettyModel(m) {
  if (!m) return '';
  const p = String(m).split('-');
  const fam = p[0].charAt(0).toUpperCase() + p[0].slice(1);
  const ver = p.slice(1).filter((x) => /^\d+$/.test(x)).join('.');
  return ver ? `${fam} ${ver}` : fam;
}

// Tiny seeded LCG so the rotation is deterministic given a seed.
function rng(seed) {
  let s = (Math.floor(seed) >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
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
  if (!a.byDay || !Object.keys(a.byDay).length) {
    return ['Not enough data yet — keep coding and check back tomorrow.'];
  }

  const C = [];
  // topic (optional) groups near-duplicates so at most one survives selection
  // (e.g. two streak lines, or peak-weekday + weekday-rhythm, never together).
  const push = (w, text, topic) => { if (text) C.push({ w, text, topic }); };

  // ── 1. Week-over-week trend (headline) ─────────────────────────────────
  const last7 = windowActive(a.byDay, 7, 0);
  const prev7 = windowActive(a.byDay, 7, 7);
  if (last7 || prev7) {
    if (prev7 > 0) {
      const delta = (last7 - prev7) / prev7;
      if (Math.abs(delta) >= 0.10) {
        const dir = delta > 0 ? 'above' : 'below';
        push(Math.abs(delta) >= 0.25 ? 95 : 78,
          `You're ${pct(delta)} ${dir} last week — ${fmtHours(last7)} vs ${fmtHours(prev7)}.`);
      } else {
        push(64, `Steady week — ${fmtHours(last7)} active, on par with the previous 7 days.`);
      }
    } else if (last7 > 0) {
      push(80, `Fresh momentum — ${fmtHours(last7)} active this past week.`);
    }
  }

  // ── 2. Chronotype (peak hour / night owl / early bird) ─────────────────
  if (a.byHour && Object.keys(a.byHour).length) {
    let total = 0, night = 0;
    for (const [h, d] of Object.entries(a.byHour)) {
      const hr = +h; const ms = d.activeMs || 0;
      total += ms;
      if (hr >= 22 || hr <= 4) night += ms;
    }
    const ph = a.peakHour && a.peakHour.hour != null ? +a.peakHour.hour : null;
    if (total > 0) {
      const ns = night / total;
      if (ns >= 0.33 || (ph != null && (ph >= 22 || ph <= 4))) {
        push(64, `Night owl — ${Math.round(ns * 100)}% of your coding is between 10pm and 5am${ph != null ? ` (peak ${hourLabel(ph)})` : ''}.`);
      } else if (ph != null && ph >= 5 && ph <= 9) {
        push(62, `Early bird — your focus peaks around ${hourLabel(ph)}.`);
      } else if (ph != null) {
        push(54, `Your most productive hour is ${hourLabel(ph)}.`);
      }
    }
  }

  // ── 3. Best day on record ──────────────────────────────────────────────
  if (a.bestDay && a.bestDay.day) {
    const md = monthDay(a.bestDay.day);
    const ago = daysAgo(a.bestDay.day);
    if (md) {
      const recent = ago != null && ago <= 1;
      const ln = a.bestDay.linesAdded || 0;
      const extra = ln > 0 ? ` and ${commas(ln)} lines` : '';
      push(recent ? 93 : 60,
        `${recent ? 'New personal best! ' : 'Biggest day so far: '}${md} — ${fmtHours(a.bestDay.activeMs || 0)}${extra}.`);
    }
  }

  // ── 4. Weekend vs weekday rhythm ───────────────────────────────────────
  if (a.byWeekday) {
    let wd = 0, wdN = 0, we = 0, weN = 0;
    for (const [k, d] of Object.entries(a.byWeekday)) {
      const n = +k; const ms = d.activeMs || 0;
      if (n === 0 || n === 6) { we += ms; weN += 1; } else if (n >= 1 && n <= 5) { wd += ms; wdN += 1; }
    }
    if (wdN && weN && wd > 0 && we > 0) {
      const aWd = wd / wdN, aWe = we / weN;
      if (aWd >= aWe * 1.6) push(55, `Weekday grinder — you average ${(aWd / aWe).toFixed(1)}× more on weekdays than weekends.`, 'weekday');
      else if (aWe >= aWd * 1.4) push(57, `Weekend warrior — your Saturdays and Sundays out-pace the work week.`, 'weekday');
    }
  }

  // ── 5. Peak weekday ────────────────────────────────────────────────────
  if (a.byWeekday && Object.keys(a.byWeekday).length) {
    let best = null;
    for (const [w, d] of Object.entries(a.byWeekday)) {
      if (!best || (d.activeMs || 0) > best.ms) best = { wd: +w, ms: d.activeMs || 0 };
    }
    if (best && best.ms > 0) push(52, `Peak weekday is ${WEEKDAYS[best.wd]} — ${fmtHours(best.ms)} all-time.`, 'weekday');
  }

  // ── 6. Output as book pages ────────────────────────────────────────────
  if ((a.linesAdded || 0) >= 500) {
    const pages = Math.max(1, Math.round(a.linesAdded / 55));
    push(48, `${commas(a.linesAdded)} lines written — about ${commas(pages)} pages of a paperback.`);
  }

  // ── 7. Cost pace (month-to-date forecast) ──────────────────────────────
  if (a.estimatedCost && a.byDay) {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let mtd = 0;
    for (const [k, day] of Object.entries(a.byDay)) if (k.startsWith(ym)) mtd += day.cost || 0;
    if (mtd > 0) {
      const daysIn = now.getDate();
      const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      push(60, `Month-to-date estimate: ${fmtCost(mtd)} — pace projects ${fmtCost((mtd / daysIn) * dim)} for the month.`);
    }
  }

  // ── 8. Hotspot file ────────────────────────────────────────────────────
  if (a.topEditedFiles && a.topEditedFiles.length) {
    const top = a.topEditedFiles[0];
    const name = top.path.split(/[\\/]/).filter(Boolean).pop();
    push(54, `Hotspot: ${name} with ${fmtNum(top.count)} edits.`);
  }

  // ── 9. Streak — milestone tease + best-ever flag ───────────────────────
  if (a.streak >= 3) {
    const next = [7, 14, 30, 60, 100, 365].find((t) => t > a.streak);
    if (next) {
      const rem = next - a.streak;
      push(rem <= 2 ? 90 : 64, `${a.streak}-day streak — ${rem} ${rem === 1 ? 'day' : 'days'} to ${next}.`, 'streak');
    } else {
      push(82, `${a.streak}-day streak — beyond every milestone we track. Incredible.`, 'streak');
    }
  } else if (a.longestStreak >= 7) {
    push(58, `Longest streak so far: ${a.longestStreak} days. Today could start the next one.`, 'streak');
  }
  if (a.streak && a.streak === a.longestStreak && a.streak >= 5) {
    push(72, `You're on your best-ever streak — ${a.streak} days and counting.`, 'streak');
  }

  // ── 10. Top language ───────────────────────────────────────────────────
  if (a.languages) {
    const top = Object.entries(a.languages).sort((x, y) => y[1].edits - x[1].edits)[0];
    if (top) push(53, `Most edits land in ${top[0]} — ${fmtNum(top[1].edits)} across ${fmtNum(top[1].files)} files.`);
  }

  // ── 11. Top project + breadth ──────────────────────────────────────────
  if (a.projects && Object.keys(a.projects).length) {
    let best = null;
    for (const [name, d] of Object.entries(a.projects)) {
      if (!best || (d.activeMs || 0) > best.ms) best = { name, ms: d.activeMs || 0, s: d.sessions || 0 };
    }
    if (best && best.ms > 0) push(56, `Most of your time goes to ${best.name} — ${fmtHours(best.ms)} across ${fmtNum(best.s)} sessions.`, 'project');
    const n = Object.keys(a.projects).length;
    if (n >= 5) push(40, `You've worked across ${n} projects with Claude Code.`, 'project');
  }

  // ── 12. Top tool + tool volume ─────────────────────────────────────────
  if (a.toolBreakdown && Object.keys(a.toolBreakdown).length) {
    const t = Object.entries(a.toolBreakdown).sort((x, y) => y[1] - x[1])[0];
    if (t && t[1] >= 10) push(44, `Your most-used tool is ${t[0]} — ${fmtNum(t[1])} calls.`);
  }
  if ((a.uniqueFiles || 0) >= 50) push(42, `${commas(a.uniqueFiles)} unique files touched.`);

  // ── 13. Top shell command ──────────────────────────────────────────────
  if (a.bashCommands && Object.keys(a.bashCommands).length) {
    const b = Object.entries(a.bashCommands).sort((x, y) => y[1] - x[1])[0];
    if (b && b[1] >= 5) push(40, `Your go-to shell command: ${b[0]} (${fmtNum(b[1])}×).`);
  }

  // ── 14. Model mix ──────────────────────────────────────────────────────
  if (Array.isArray(a.modelSplit) && a.modelSplit.length) {
    const m = a.modelSplit[0];
    if (m && m.tokenPct > 0) push(50, `${prettyModel(m.model)} does most of your work — ${Math.round(m.tokenPct * 100)}% of tokens.`, 'model');
    if (a.modelSplit.length >= 3) push(38, `${a.modelSplit.length} models in your rotation.`, 'model');
  }

  // ── 15. Subagents ──────────────────────────────────────────────────────
  if ((a.subagentRuns || 0) >= 5) {
    let topName = null, topN = 0;
    for (const [name, n] of Object.entries(a.subagents || {})) if (n > topN) { topN = n; topName = name; }
    push(46, `${fmtNum(a.subagentRuns)} subagent runs${topName ? ` — favourite is ${topName}` : ''}.`);
  }

  // ── 16. Cache efficiency ───────────────────────────────────────────────
  const totalTok = (a.inputTokens || 0) + (a.outputTokens || 0) + (a.cacheReadTokens || 0) + (a.cacheWriteTokens || 0);
  if (totalTok > 0 && (a.cacheReadTokens || 0) / totalTok >= 0.5) {
    push(46, `${Math.round((a.cacheReadTokens / totalTok) * 100)}% of your tokens come from cache — heavy context reuse.`);
  }

  // ── 17. Tenure / anniversary ───────────────────────────────────────────
  if (a.daysSinceFirst >= 2) {
    const near = [7, 30, 100, 182, 365, 730].find((t) => t >= a.daysSinceFirst && t - a.daysSinceFirst <= 3);
    if (near && near === a.daysSinceFirst) push(78, `Day ${near} with Claude Code — milestone unlocked.`);
    else if (near) push(70, `${near - a.daysSinceFirst} ${near - a.daysSinceFirst === 1 ? 'day' : 'days'} to your ${near}-day mark with Claude Code.`);
    else push(44, `Day ${a.daysSinceFirst} with Claude Code.`);
  }

  // ── 18. Cadence ────────────────────────────────────────────────────────
  if (a.daysSinceFirst >= 7 && a.sessions > 0) {
    const per = a.sessions / a.daysSinceFirst;
    if (per >= 1) push(40, `~${per.toFixed(1)} sessions a day since you started.`);
  }

  // ── 19. Web research breadth ───────────────────────────────────────────
  if (a.webDomains && Object.keys(a.webDomains).length >= 10) {
    push(36, `Researched across ${Object.keys(a.webDomains).length} web domains.`);
  }

  // ── 20. Notifications ──────────────────────────────────────────────────
  if (a.notifications && a.notifications > 20) {
    push(38, `${fmtNum(a.notifications)} notifications — Claude has paused for you that many times.`);
  }

  if (!C.length) return ['Not enough data yet — keep coding and check back tomorrow.'];

  // Weighted random draw WITHOUT replacement. Weight sets how often (and how
  // early) a line tends to surface, but every run is a genuinely fresh mix —
  // including the top line — rather than the same weight-sorted five. Default
  // seed = clock → fresh each run; pass opts.seed for a deterministic order.
  // Topic keeps near-duplicates (two streak lines, etc.) out of the same draw.
  const rand = rng(opts.seed != null ? opts.seed : Date.now());
  const limit = opts.limit ?? 5;
  const pool = C.slice();
  const seen = new Set();
  const out = [];
  while (out.length < limit && pool.length) {
    let total = 0;
    for (const c of pool) total += c.w;
    let r = rand() * total;
    let idx = 0;
    while (idx < pool.length - 1 && (r -= pool[idx].w) > 0) idx++;
    const [c] = pool.splice(idx, 1);
    if (c.topic && seen.has(c.topic)) continue;
    if (c.topic) seen.add(c.topic);
    out.push(c.text);
  }
  return out;
}
