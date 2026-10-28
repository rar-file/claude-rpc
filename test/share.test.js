import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShareArgs, shareCaption, SHARE_URL } from '../src/share.js';

test('parseShareArgs: defaults to the last week with a PNG and a copy', () => {
  assert.deepEqual(parseShareArgs([]), { range: 'week', png: true, path: null, copy: true });
  assert.equal(parseShareArgs(['month']).range, 'month');
  assert.equal(parseShareArgs(['--no-png']).png, false);
  assert.equal(parseShareArgs(['--png', 'x.png']).path, 'x.png');
  assert.ok(parseShareArgs(['--png']).error);
  assert.ok(parseShareArgs(['fortnight']).error);
});

test('shareCaption: real numbers, zeros skipped, link back', () => {
  const r = { activeMs: 9_000_000, userMessages: 55, tokens: 0, linesAdded: 1400 };
  const cap = shareCaption(r, { range: 'week', streak: 3 });
  assert.match(cap, /^My last 7 days: /);
  assert.match(cap, /55 prompts/);
  assert.doesNotMatch(cap, /tokens/, 'zero tokens left out');
  assert.match(cap, /3-day streak/);
  assert.ok(cap.endsWith(SHARE_URL));
});

test('shareCaption: an empty window still reads naturally', () => {
  const cap = shareCaption({ activeMs: 0, userMessages: 0, tokens: 0, linesAdded: 0 }, { range: 'month', streak: 1 });
  assert.match(cap, /^Tracking my Claude Code sessions\./);
  assert.doesNotMatch(cap, /streak/);
});
