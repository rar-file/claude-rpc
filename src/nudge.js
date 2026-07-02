// Share nudges — the gentle half of the viral loop. When you cross a genuine
// milestone (a streak record, a round number of sessions or hours), the CLI
// offers a one-liner to share it. Deliberately conservative:
//
//   - Only ever surfaces the single biggest *new* milestone, and only once
//     (deduped by key in a tiny state file). Crossing nothing new → silence.
//   - Off-switch: config.nudges.enabled === false.
//   - Never throws and never blocks — it's the last thing printed, best-effort.
//
// pickShareNudge is pure (aggregate, lastKey) → nudge|null, so it's unit-tested
// without touching disk.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { STATE_DIR } from './paths.js';

const NUDGE_STATE = join(STATE_DIR, 'nudge-state.json');

// Largest milestone in `list` that `value` has reached, or null.
function reached(value, list) {
  let hit = null;
  for (const m of list) if (value >= m) hit = m;
  return hit;
}

const fmt = (n) => n >= 1000 ? n.toLocaleString('en-US') : String(n);

// Returns { key, weight, message } for the biggest milestone the aggregate has
// crossed that hasn't been shown yet, or null. `weight` ranks across milestone
// types so we show the single most impressive UNSEEN one — without the `shown`
// filter, a standing streak record (weight 1000+) re-won every pick, matched
// the dedup, and permanently silenced every other milestone behind it.
export function pickShareNudge(agg, shown = new Set()) {
  if (!agg || typeof agg !== 'object') return null;
  const out = [];

  const streak = agg.streak || 0;
  const longest = agg.longestStreak || 0;
  // Only celebrate a streak when it's also a personal record — otherwise the
  // "share your streak" prompt fires mid-decline, which feels off.
  if (streak >= 3 && streak === longest) {
    const m = reached(streak, [3, 7, 14, 30, 50, 100, 200, 365]);
    if (m) out.push({
      key: `streak:${m}`, weight: 1000 + m,
      message: `${m}-day streak — a personal record. Drop a live badge in your README: \`claude-rpc badge --metric streak --gist\``,
    });
  }

  const sessions = agg.sessions || 0;
  const s = reached(sessions, [50, 100, 250, 500, 1000, 2500, 5000, 10000]);
  if (s) out.push({
    key: `sessions:${s}`, weight: s / 50,
    message: `${fmt(s)} Claude Code sessions logged. Show it off: \`claude-rpc card --range all --out claude.svg\` (or --gist for a live one).`,
  });

  const hours = Math.floor((agg.activeMs || 0) / 3_600_000);
  const h = reached(hours, [50, 100, 250, 500, 1000, 2000, 5000]);
  if (h) out.push({
    key: `hours:${h}`, weight: h,
    message: `${fmt(h)}+ hours on Claude Code. Your year-in-review is ready — \`claude-rpc serve\` then open /wrapped and hit Share.`,
  });

  const fresh = out.filter((n) => !shown.has(n.key));
  if (!fresh.length) return null;
  fresh.sort((a, b) => b.weight - a.weight);
  return fresh[0];
}

// A quiet, local celebration line for `claude-rpc today`. Complements the
// share nudges above — which own streak records and round session/hour
// counts — without overlapping them: this detects lifetime-token round
// numbers CROSSED TODAY (no state file needed — the crossing happened today
// iff total ≥ mark and total − todayTokens < mark) and round "day N"
// anniversaries (which are only true on the day itself). Returns one string
// or null; the caller styles it.
const TOKEN_MARKS = [1e9, 5e9, 1e10, 2.5e10, 5e10, 1e11, 2.5e11, 5e11, 1e12];
const DAY_MARKS = new Set([50, 100, 200, 365, 500, 730, 1000]);
const fmtTok = (n) => n >= 1e12 ? `${n / 1e12}T` : n >= 1e9 ? `${n / 1e9}B` : `${n / 1e6}M`;

export function pickTodayMilestone(agg, todayTokens = 0) {
  if (!agg || typeof agg !== 'object') return null;
  const total = (agg.inputTokens || 0) + (agg.outputTokens || 0)
    + (agg.cacheReadTokens || 0) + (agg.cacheWriteTokens || 0);
  for (let i = TOKEN_MARKS.length - 1; i >= 0; i--) {
    const mark = TOKEN_MARKS[i];
    if (total >= mark && total - todayTokens < mark) {
      return `crossed ${fmtTok(mark)} lifetime tokens today`;
    }
  }
  if (DAY_MARKS.has(agg.daysSinceFirst || 0)) return `day ${agg.daysSinceFirst} with claude`;
  return null;
}

// Set of every nudge key already shown. Older state files stored a single
// `key`; fold it in so upgrading doesn't re-show the last nudge.
function readShownKeys(path = NUDGE_STATE) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const keys = Array.isArray(raw.shown) ? raw.shown : [];
    if (raw.key) keys.push(raw.key);
    return new Set(keys.filter((k) => typeof k === 'string'));
  } catch { return new Set(); }
}

function writeShownKeys(shown, path = NUDGE_STATE) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // Cap the history — milestone lists are finite, 100 is plenty.
    writeFileSync(path, JSON.stringify({ shown: [...shown].slice(-100), ts: Date.now() }));
  } catch { /* best-effort */ }
}

// Resolve a nudge to print right now, honoring the config gate and once-only
// dedup. Returns a string to print, or null. Marks the nudge as shown.
export function maybeNudge(agg, config = {}, { path = NUDGE_STATE } = {}) {
  if (config?.nudges?.enabled === false) return null;
  const shown = readShownKeys(path);
  const n = pickShareNudge(agg, shown);
  if (!n) return null;
  shown.add(n.key);
  writeShownKeys(shown, path);
  return n.message;
}
