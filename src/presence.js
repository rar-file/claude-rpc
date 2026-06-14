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
