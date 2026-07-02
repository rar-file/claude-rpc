// Canonical number/duration formatters shared across the card, badge, profile,
// insights and the live presence engine (format.js re-exports these). Single
// source of truth so tier-boundary rounding behaves identically everywhere —
// the copies had drifted (sub-1000 rounding, a missing Billion tier).
//
// NOTE: worker/src/badge.js keeps a byte-for-byte copy of fmtNum — the worker
// deploys dependency-free and can't import across the package boundary. Keep
// the two in sync; test/format.test.js pins fmtNum's tier behavior.

// Compact integer: 999 → "999", 1_500 → "1.5k", 1_500_000 → "1.50M", up to "B".
// The unit is chosen from the ROUNDED value, so 999_999 → "1.00M" (not the old
// "1000.0k") and 999_999_999 → "1.00B".
export function fmtNum(n) {
  if (!n) return '0';
  const neg = n < 0 ? '-' : '';
  const v = Math.abs(n);
  if (v < 1000) return neg + Math.round(v);
  for (const [suf, div, prec] of [['k', 1e3, 1], ['M', 1e6, 2], ['B', 1e9, 2]]) {
    const s = (v / div).toFixed(prec);
    if (Number(s) < 1000) return neg + s + suf;
  }
  return neg + (v / 1e9).toFixed(2) + 'B'; // ≥ ~1e12 stays in the B tier
}

// Duration from ms: <60m → "42m", <10h → "2.5h", else "12h". Rounds to whole
// minutes first so 59.7m → "1.0h" (not the old "60m").
export function fmtHours(ms) {
  if (!ms || ms < 0) return '0h';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = mins / 60;
  return hours < 10 ? `${hours.toFixed(1)}h` : `${Math.round(hours)}h`;
}

// Local calendar date "YYYY-MM-DD" — the same day the scanner's byDay buckets
// key on. Card/calendar/profile stamps used toISOString(), which is UTC and
// labels the data with the wrong day for any non-UTC user near midnight.
export function localDateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
