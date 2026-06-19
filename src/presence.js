// Pure presence-render helpers extracted from daemon.js so the most
// regression-prone bits of the Discord payload — frame selection, rotation
// cursoring, and large-image precedence — are unit-testable. daemon.js can't be
// imported under test (it connects IPC and writes a PID file at module load),
// so this is where that logic lives and gets covered.

// A rotation cursor. The daemon owns one instance; selectFrame reads + advances
// it across ticks. Kept as plain mutable state (not a closure) so it can be
// constructed fresh in a test.
export function makeRotationCursor() {
  return { index: 0, lastAt: 0, status: null };
}

// Choose the active frame set for a status from the new `presence.byStatus`
// block when present. A byStatus entry is { details, state, largeImageText,
// rotation? }: with a rotation the base { details, state } renders first and the
// rotation array cycles after it; otherwise it's a single fixed frame. Falls
// back to a legacy top-level p.rotation, then a single { details, state } frame.
// Returns { frames, largeImageTextTpl }.
export function pickFrames(p, status) {
  const sb = p.byStatus?.[status];
  if (sb) {
    const base = { details: sb.details, state: sb.state, largeImageText: sb.largeImageText };
    const frames = Array.isArray(sb.rotation) && sb.rotation.length ? [base, ...sb.rotation] : [base];
    return { frames, largeImageTextTpl: sb.largeImageText || null };
  }
  if (Array.isArray(p.rotation) && p.rotation.length) return { frames: p.rotation, largeImageTextTpl: null };
  return { frames: [{ details: p.details, state: p.state }], largeImageTextTpl: null };
}

// Pick the frame to render this tick. Drops frames whose `requires` vars are
// empty/zero (keeping at least the base frame), resets the cursor on a status
// change — STARTING on the base frame — and advances at most once per
// intervalMs. `framePasses` and `now` are injected so this is testable without
// format.js or a real clock.
//
// #5 fix: the prior code reset lastAt to 0 on a status change, so on the very
// next tick `now - 0 >= intervalMs` was always true and the cursor advanced
// straight past the base frame — entering idle landed the user mid-rotation on a
// lifetime-stats frame instead of "Idle in <project>". Seeding lastAt to `now`
// keeps the first tick on index 0.
export function selectFrame(rawFrames, vars, status, cursor, intervalMs, framePasses, now) {
  if (status !== cursor.status) {
    cursor.index = 0;
    cursor.lastAt = now;
    cursor.status = status;
  }
  const passing = (rawFrames || []).filter((f) => framePasses(f, vars));
  const frames = passing.length ? passing : (rawFrames || []).slice(0, 1);
  if (!frames.length) return {};
  if (frames.length > 1 && now - cursor.lastAt >= intervalMs) {
    cursor.index = (cursor.index + 1) % frames.length;
    cursor.lastAt = now;
  }
  return frames[cursor.index % frames.length] || {};
}

// Pick which session's card to show when several Claude sessions run at once.
// Each session writes its own state-<id>.json (lastActivity stamped on every
// hook), so `states` is one entry per session. Behavior: STICK to the currently
// shown session while it's still active (lastActivity within idleMs), so the
// card doesn't thrash between sessions while you're working in one; only once
// the shown session goes idle do we switch to the most-recently-active session.
// Returns { state, sessionId, liveCount } — liveCount feeds the "N sessions"
// party field so it stays consistent with what's displayed.
export function pickActiveSession(states, displayedId, now, idleMs) {
  const list = (states || []).filter((s) => s && s.sessionId);
  if (!list.length) return { state: null, sessionId: null, liveCount: 0 };
  // A just-ended session (SessionEnd → claudeClosed) stamps a recent
  // lastActivity but is gone — never count it live or stick to it.
  const isLive = (s) => !s.claudeClosed && now - (s.lastActivity || 0) <= idleMs;
  const liveCount = list.filter(isLive).length;
  const byRecent = [...list].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  // Stickiness: keep the shown session while it's still active.
  const current = list.find((s) => s.sessionId === displayedId);
  if (current && isLive(current)) {
    return { state: current, sessionId: current.sessionId, liveCount };
  }
  // Otherwise show the most-recently-active live session — or, if none are live,
  // the most-recent overall so the card follows the last session into idle/stale
  // rather than blanking.
  const chosen = byRecent.find(isLive) || byRecent[0];
  return { state: chosen, sessionId: chosen.sessionId, liveCount };
}

// Should the daemon auto-add a "View on GitHub →" button for this cwd? The
// button URL is read from .git/config (no `gh` needed), but private-repo
// detection DOES need the gh CLI — so on a machine without gh a private repo
// can't be detected and its link would leak onto the card. This is the explicit
// kill switch (`presence.githubButton: false`), independent of gh; it also stays
// suppressed while stale or under any non-public privacy verdict.
export function shouldShowGithubButton(p, state) {
  if (p.githubButton === false) return false;
  if (!state || state.status === 'stale') return false;
  if (state._privacy && state._privacy.visibility !== 'public') return false;
  return true;
}

// Decide how to transmit a candidate presence payload without tripping Discord's
// SET_ACTIVITY rate limit. Discord hard-limits activity writes (~5 per 20s) and
// punishes a burst — calling it ~10× in 5s makes the client EMPTY the presence
// and stop updating until the writes stop (discord-api-docs#668). Claude Code
// fires PreToolUse/PostToolUse hooks back-to-back through a flurry of quick
// Reads/Edits, so the daemon would otherwise write many times a second. The
// Game SDK claims to coalesce-and-queue for you; raw IPC (what we speak) gives
// no such cushion, so we throttle ourselves.
//
// This is the leading+trailing decision — pure so it's unit-testable; the daemon
// owns the wall clock, the last-sent bookkeeping, and the flush timer:
//   - 'skip'  : byte-identical to what's already on the wire — do nothing
//   - 'send'  : the gap has elapsed and nothing is queued — write immediately
//               (snappy idle→thinking→working transitions)
//   - 'defer' : inside the gap, or a flush is already queued — coalesce to the
//               LATEST payload and let the caller flush it in `waitMs`, so the
//               final state of every burst still lands, once, under the limit
//
// The per-write `gapMs` only spaces *consecutive* writes; it does NOT bound
// writes-per-window. With gapMs == windowMs/maxPerWindow (the 4s default sits
// exactly on Discord's ~5-per-20s ceiling) a 20s window can still catch
// floor(windowMs/gapMs)+1 == 6 gap-spaced writes — one over the limit — because
// many independent triggers (the rotation tick re-rendering {toolElapsed}, a
// background scan, a live-session change, a config reload) each want to write.
// That extra write is exactly what makes Discord EMPTY the presence (the card
// collapses to just the app name + elapsed timer). So when `recentSends` (the
// timestamps of recent writes, set+clear) and `maxPerWindow` are supplied we
// add a hard sliding-window cap on top of the gap: defer until the oldest write
// in the window expires, guaranteeing no more than `maxPerWindow` writes in any
// `windowMs` no matter how many triggers fire. Omitting them keeps the old
// gap-only behavior (used by tests that predate the cap).
export function throttleDecision({ hash, lastSentHash, lastSentAt, now, gapMs, flushPending, recentSends, windowMs, maxPerWindow }) {
  if (hash === lastSentHash) return { action: 'skip', waitMs: 0 };
  let waitMs = Math.max(0, (lastSentAt || 0) + gapMs - now);
  if (maxPerWindow && windowMs && Array.isArray(recentSends)) {
    // Strict window (age < windowMs) so a write exactly windowMs old has already
    // fallen out — matches a "requests in the last 20s" limiter and keeps the
    // boundary case from sneaking a write over the line.
    const inWindow = recentSends.filter((t) => t > now - windowMs);
    if (inWindow.length >= maxPerWindow) {
      // The oldest write we must let expire before another may go out. Once it
      // ages past windowMs the window drops below the cap and we can send.
      const oldest = inWindow[inWindow.length - maxPerWindow];
      waitMs = Math.max(waitMs, oldest + windowMs - now);
    }
  }
  if (waitMs === 0 && !flushPending) return { action: 'send', waitMs: 0 };
  return { action: 'defer', waitMs };
}

// Large-image key precedence (returns the TEMPLATE string; the caller fills it):
//   1. statusAssets[status]          per-status art ("working" gif, etc.)
//   2. modelAssets[fable|opus|sonnet|haiku|default]   per-model art, never stale
//   3. p.largeImageKey               global fallback
export function resolveLargeImageKey(config, p, status, model) {
  if (config.statusAssets && config.statusAssets[status]) return config.statusAssets[status];
  if (config.modelAssets && model && status !== 'stale') {
    const m = String(model).toLowerCase();
    let pick = null;
    if (m.includes('fable')) pick = config.modelAssets.fable;
    else if (m.includes('opus')) pick = config.modelAssets.opus;
    else if (m.includes('sonnet')) pick = config.modelAssets.sonnet;
    else if (m.includes('haiku')) pick = config.modelAssets.haiku;
    if (!pick) pick = config.modelAssets.default;
    if (pick) return pick;
  }
  return p.largeImageKey || null;
}
