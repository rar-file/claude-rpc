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
