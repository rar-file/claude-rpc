// ui.js — shared CLI output primitives. fail() exits the process,
// which can't be exercised in-process without taking the test runner
// down with it. We pin the easier exports: symbol constants are
// non-empty strings, exit codes are the documented set, ok/info/warn
// write the expected shape to stdout, and check() routes by status.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { SYM_OK, SYM_FAIL, SYM_WARN, SYM_INFO, EX_OK, EX_USER_ERROR, EX_SYS_ERROR, EX_BAD_STATE, ok, info, warn, check, c, tailLines } =
  await import('../src/ui.js');

test('symbol constants are non-empty', () => {
  for (const s of [SYM_OK, SYM_FAIL, SYM_WARN, SYM_INFO]) {
    assert.ok(typeof s === 'string' && s.length > 0);
  }
});

test('exit codes are the documented set', () => {
  assert.equal(EX_OK, 0);
  assert.equal(EX_USER_ERROR, 1);
  assert.equal(EX_SYS_ERROR, 2);
  assert.equal(EX_BAD_STATE, 3);
});

test('color table at least defines the named slots', () => {
  for (const k of ['reset', 'dim', 'bold', 'red', 'green', 'yellow', 'cyan', 'gray']) {
    assert.ok(k in c, `c.${k} present`);
  }
});

// Capture stdout/stderr around a callback. Restores the originals
// even if the callback throws.
function capture(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  try { fn(); }
  finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { out: out.join(''), err: err.join('') };
}

test('ok prints to stdout with the OK symbol', () => {
  const { out } = capture(() => ok('all good', 'detail line'));
  assert.match(out, /all good/);
  assert.match(out, /detail line/);
});

test('info prints to stdout with the info symbol', () => {
  const { out } = capture(() => info('heads up', 'extra'));
  assert.match(out, /heads up/);
});

test('warn prints to stdout with a hint line when given', () => {
  const { out } = capture(() => warn('careful', 'this is the hint'));
  assert.match(out, /careful/);
  assert.match(out, /this is the hint/);
});

test('check routes pass/fail/warn and prints hint only on non-pass', () => {
  const pass = capture(() => check('one', 'pass', 'detail', 'no hint shown'));
  assert.match(pass.out, /one/);
  assert.match(pass.out, /detail/);
  assert.equal(pass.out.includes('no hint shown'), false, 'hint suppressed on pass');

  const fail = capture(() => check('two', 'fail', 'detail', 'fix it'));
  assert.match(fail.out, /two/);
  assert.match(fail.out, /fix it/);
});

// tailLines — regression tests for the trailing-newline bug (issue #14)
test('tailLines: file ending with newline returns correct lines', () => {
  const raw = 'a\nb\nc\n';
  assert.deepEqual(tailLines(raw), ['a', 'b', 'c']);
});

test('tailLines: file without trailing newline preserves last line (regression)', () => {
  const raw = 'a\nb\nc';
  assert.deepEqual(tailLines(raw), ['a', 'b', 'c']);
});

test('tailLines: respects n limit with trailing newline', () => {
  const raw = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') + '\n';
  const result = tailLines(raw);
  assert.equal(result.length, 30);
  assert.equal(result[0], 'line10');
  assert.equal(result[29], 'line39');
});

test('tailLines: respects n limit without trailing newline', () => {
  const raw = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n');
  const result = tailLines(raw);
  assert.equal(result.length, 30);
  assert.equal(result[29], 'line39');
});

test('tailLines: empty string returns empty array', () => {
  assert.deepEqual(tailLines(''), []);
});

test('tailLines: single line with newline', () => {
  assert.deepEqual(tailLines('only\n'), ['only']);
});

test('tailLines: single line without newline', () => {
  assert.deepEqual(tailLines('only'), ['only']);
});

// ── Heat / sparkline / comparison primitives ────────────────────────────

const { heat, sparkline, fmtDelta, topPercentile } = await import('../src/ui.js');

test('heat: ramp moves green → amber → rust with intensity, off without a tty', () => {
  // Test runner has no TTY → default heat is the no-color empty string.
  assert.equal(heat(0.9), '');
  // Forced-tty path exposes the actual ramp for assertion.
  const codes = [0.1, 0.3, 0.5, 0.7, 1].map((t) => heat(t, { tty: true }));
  assert.equal(new Set(codes).size, 5, 'five distinct ramp stops');
  for (const code of codes) assert.match(code, /^\x1b\[38;5;\d+m$/);
  assert.equal(heat(1, { tty: true }), heat(2, { tty: true }), 'clamps above 1');
});

test('sparkline: scales to its own max, blank for zero days, empty without data', () => {
  assert.equal(sparkline([0, 0, 0]), '');
  assert.equal(sparkline([]), '');
  const s = sparkline([1, 4, 8, 0, 2]);
  assert.equal(s.length, 5, 'one glyph per value (no color in test env)');
  assert.equal(s[2], '█', 'max value renders full block');
  assert.equal(s[3], ' ', 'zero day renders blank');
  assert.ok(s[0] !== ' ' && s[0] !== '█', 'small nonzero value is visible but not full');
});

test('fmtDelta: direction arrows with percent, capped, silent without a baseline', () => {
  assert.equal(fmtDelta(118, 100), '▲ +18%');
  assert.equal(fmtDelta(66, 100), '▼ −34%');
  assert.equal(fmtDelta(118, 100, { vs: 'vs 7-day avg' }), '▲ +18% vs 7-day avg');
  assert.equal(fmtDelta(100, 100), '≈ usual');
  assert.equal(fmtDelta(5, 0), '', 'no baseline → no comparison');
  assert.equal(fmtDelta(500000, 100), '▲ +999%', 'display capped at 999%');
});

test('topPercentile: quiet without history, callouts only for standout days', () => {
  const history = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
  assert.equal(topPercentile(history, 200), 'best day yet');
  assert.equal(topPercentile(history, 195), 'top 10% day');
  assert.equal(topPercentile(history, 160), 'top 25% day');
  assert.equal(topPercentile(history, 100), '', 'middling day stays quiet');
  assert.equal(topPercentile([10, 20, 30], 30), '', 'too little history stays quiet');
  assert.equal(topPercentile(history, 0), '', 'zero day never ranks');
});
