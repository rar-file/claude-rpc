// Shared CLI output primitives.
//
// Three duplicates of the same ANSI table + symbol set existed in cli.js,
// doctor.js, and tui.js. This is the one place; everything else imports.
//
// All output goes to stdout/stderr via console.log/console.error. The
// daemon's file-bound `log()` is a separate concern (no tty, no color)
// and stays in src/daemon.js — these helpers are for human-facing
// surfaces only.
//
// Standard exit codes (also documented in --help):
//   0  success
//   1  user error  — bad args, unknown command, malformed input
//   2  system error — IO failed, Discord unreachable, etc.
//   3  wrong state — daemon already running, no aggregate yet, etc.

import process from 'node:process';

const TTY = process.stdout.isTTY && !process.env.NO_COLOR;

export const c = {
  reset:   TTY ? '\x1b[0m'  : '',
  dim:     TTY ? '\x1b[2m'  : '',
  bold:    TTY ? '\x1b[1m'  : '',
  red:     TTY ? '\x1b[31m' : '',
  green:   TTY ? '\x1b[32m' : '',
  yellow:  TTY ? '\x1b[33m' : '',
  blue:    TTY ? '\x1b[34m' : '',
  magenta: TTY ? '\x1b[35m' : '',
  cyan:    TTY ? '\x1b[36m' : '',
  gray:    TTY ? '\x1b[90m' : '',
};

export const SYM_OK   = TTY ? `${c.green}✓${c.reset}`  : '[ok]  ';
export const SYM_FAIL = TTY ? `${c.red}✗${c.reset}`    : '[fail]';
export const SYM_WARN = TTY ? `${c.yellow}!${c.reset}` : '[warn]';
export const SYM_INFO = TTY ? `${c.cyan}·${c.reset}`   : '[info]';

// Standard exit-code values. Use these instead of process.exit(1) so
// intent is visible in the source.
export const EX_OK         = 0;
export const EX_USER_ERROR = 1;
export const EX_SYS_ERROR  = 2;
export const EX_BAD_STATE  = 3;

// Hint lines sit directly under the message they belong to, aligned with the
// label (the symbol column differs between TTY glyphs and [fail]-style tags).
const HINT_INDENT = ' '.repeat(TTY ? 5 : 10);

export function hintLine(text, stream = process.stdout) {
  stream.write(`${HINT_INDENT}${c.gray}↳ ${text}${c.reset}\n`);
}

// Print a one-line message plus aligned dim hint line(s) below it. A hint is
// the tired-user safety net: it tells you what to type next. Accepts a single
// string or an array (one ↳ line each); empty omits them.
function withHint(sym, label, hint, stream = process.stdout) {
  stream.write(`  ${sym}  ${label}\n`);
  const hints = Array.isArray(hint) ? hint : (hint ? [hint] : []);
  for (const h of hints) hintLine(h, stream);
}

export function ok(label, detail = '') {
  process.stdout.write(`  ${SYM_OK}  ${label}${detail ? `  ${c.dim}${detail}${c.reset}` : ''}\n`);
}

export function info(label, detail = '') {
  process.stdout.write(`  ${SYM_INFO}  ${label}${detail ? `  ${c.dim}${detail}${c.reset}` : ''}\n`);
}

export function warn(label, hint = '') {
  withHint(SYM_WARN, label, hint);
}

// Print a failure with an optional hint and exit with the given code. Hints
// must be contextual: point at `claude-rpc doctor` only for local wiring or
// state problems it actually diagnoses — for usage errors, remote rejections,
// and network failures, give a directly useful hint or none at all.
export function fail(label, { hint = '', code = EX_USER_ERROR } = {}) {
  withHint(SYM_FAIL, label, hint, process.stderr);
  process.exit(code);
}

// ── Heat / sparkline / comparison primitives ──────────────────────────────
//
// Shared by the focused views (today / week / status / TUI). All of these
// degrade to plain glyphs when colors are off, so piped output stays clean.

// Intensity 0..1 → a 256-color ramp matching the site palette: calm green
// for light activity, amber for solid, rust for hot. `tty` is overridable so
// the ramp is unit-testable in a non-TTY test runner.
const HEAT_RAMP = [
  [0.25, '\x1b[38;5;65m'],  // sage — barely warm
  [0.45, '\x1b[38;5;71m'],  // green — steady
  [0.65, '\x1b[38;5;178m'], // amber — solid
  [0.85, '\x1b[38;5;208m'], // orange — heavy
  [Infinity, '\x1b[38;5;166m'], // rust — peak
];
export function heat(t, { tty = TTY } = {}) {
  if (!tty) return '';
  if (!(t > 0)) return c.dim;
  for (const [ceil, color] of HEAT_RAMP) if (t < ceil) return color;
  return HEAT_RAMP.at(-1)[1];
}

// Heat-colored sparkline of a numeric series (▁▂▃▄▅▆▇█), scaled to its own
// max. Zero/empty input → ''. With colors off this is just the glyphs.
const SPARK_CHARS = ' ▁▂▃▄▅▆▇█';
export function sparkline(values, { tty = TTY } = {}) {
  const max = Math.max(0, ...values.map((v) => v || 0));
  if (!(max > 0)) return '';
  const out = values.map((raw) => {
    const v = raw || 0;
    const idx = v > 0 ? Math.max(1, Math.min(8, Math.round((v / max) * 8))) : 0;
    return `${heat(v / max, { tty })}${SPARK_CHARS[idx]}`;
  }).join('');
  return out + (tty ? c.reset : '');
}

// "▲ +18% vs 7-day avg" — current vs a baseline, colored by direction.
// A quiet day isn't a failure, so down renders gray, not red. Returns ''
// when the baseline is too small to compare against (fresh installs).
export function fmtDelta(current, baseline, { vs = '' } = {}) {
  if (!(baseline > 0)) return '';
  const pct = Math.round(((current || 0) - baseline) / baseline * 100);
  const tail = vs ? ` ${c.dim}${vs}${c.reset}` : '';
  if (pct === 0) return `${c.dim}≈ ${vs || 'usual'}${c.reset}`;
  const up = pct > 0;
  const shown = Math.min(Math.abs(pct), 999); // a 40×-average day reads "+999%", not noise
  return `${up ? c.green : c.gray}${up ? '▲' : '▼'} ${up ? '+' : '−'}${shown}%${c.reset}${tail}`;
}

// Percentile callout for a standout value among its history ("top 10% day").
// Quiet unless there's real history to rank against and the value is high —
// a callout on every middling day would train the eye to skip it.
export function topPercentile(values, v, { min = 14 } = {}) {
  const past = values.filter((x) => x > 0);
  if (past.length < min || !(v > 0)) return '';
  const rank = past.filter((x) => x <= v).length / past.length;
  if (rank >= 1) return 'best day yet';
  if (rank >= 0.9) return 'top 10% day';
  if (rank >= 0.75) return 'top 25% day';
  return '';
}

// Return the last n lines of a log file's raw text, trimming the trailing
// empty element that split('\n') produces when the file ends with a newline.
// When the file lacks a trailing newline the last element is the last real
// line — the old raw.slice(-31,-1) pattern silently dropped it.
export function tailLines(raw, n = 30) {
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n);
}

// Compatibility with doctor.js's existing API. Same `check(label, status,
// detail, hint)` signature; doctor.js can switch its private copy out for
// this without behavior change.
export function check(label, status, detail = '', hint = '') {
  let sym;
  if (status === 'pass')      sym = SYM_OK;
  else if (status === 'fail') sym = SYM_FAIL;
  else if (status === 'warn') sym = SYM_WARN;
  else                        sym = SYM_INFO;
  const tail = detail ? `  ${c.dim}${detail}${c.reset}` : '';
  process.stdout.write(`  ${sym}  ${label}${tail}\n`);
  if (hint && status !== 'pass') hintLine(hint);
}
