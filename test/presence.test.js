// presence.js — the frame-selection / rotation / large-image logic lifted out
// of daemon.js (which can't be imported under test). These are the most
// regression-prone bits of the Discord payload, previously untested.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { makeRotationCursor, pickFrames, selectFrame, resolveLargeImageKey } =
  await import('../src/presence.js');

// ── pickFrames ─────────────────────────────────────────────────────────
test('pickFrames: byStatus base + rotation renders base first', () => {
  const p = { byStatus: { idle: { details: 'Idle', state: 'S', largeImageText: 'L',
    rotation: [{ details: 'R1' }, { details: 'R2' }] } } };
  const { frames, largeImageTextTpl } = pickFrames(p, 'idle');
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0], { details: 'Idle', state: 'S', largeImageText: 'L' });
  assert.equal(frames[1].details, 'R1');
  assert.equal(largeImageTextTpl, 'L');
});

test('pickFrames: byStatus single frame (no rotation)', () => {
  const { frames } = pickFrames({ byStatus: { working: { details: 'W', state: 'X' } } }, 'working');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].details, 'W');
});

test('pickFrames: falls back to legacy top-level rotation, then a single frame', () => {
  assert.deepEqual(pickFrames({ rotation: [{ details: 'A' }] }, 'idle').frames, [{ details: 'A' }]);
  assert.deepEqual(pickFrames({ details: 'D', state: 'E' }, 'idle').frames, [{ details: 'D', state: 'E' }]);
});

// ── selectFrame ────────────────────────────────────────────────────────
const pass = () => true; // framePasses stub: every frame passes

test('selectFrame: first tick after a status change stays on the BASE frame (#5)', () => {
  const cursor = makeRotationCursor();
  const frames = [{ details: 'base' }, { details: 'r1' }, { details: 'r2' }];
  // Entering a new status: must render index 0, not immediately advance.
  const f = selectFrame(frames, {}, 'idle', cursor, 12000, pass, 1_000_000);
  assert.equal(f.details, 'base');
  assert.equal(cursor.index, 0);
});

test('selectFrame: advances once per interval, wraps around', () => {
  const cursor = makeRotationCursor();
  const frames = [{ details: 'a' }, { details: 'b' }];
  let now = 1_000_000;
  assert.equal(selectFrame(frames, {}, 'idle', cursor, 12000, pass, now).details, 'a'); // seed
  now += 5000;  // < interval: no advance
  assert.equal(selectFrame(frames, {}, 'idle', cursor, 12000, pass, now).details, 'a');
  now += 8000;  // crosses interval since lastAt
  assert.equal(selectFrame(frames, {}, 'idle', cursor, 12000, pass, now).details, 'b');
  now += 12000; // wraps back to a
  assert.equal(selectFrame(frames, {}, 'idle', cursor, 12000, pass, now).details, 'a');
});

test('selectFrame: a single frame never advances', () => {
  const cursor = makeRotationCursor();
  const f1 = selectFrame([{ details: 'solo' }], {}, 'working', cursor, 12000, pass, 0);
  const f2 = selectFrame([{ details: 'solo' }], {}, 'working', cursor, 12000, pass, 999999);
  assert.equal(f1.details, 'solo');
  assert.equal(f2.details, 'solo');
  assert.equal(cursor.index, 0);
});

test('selectFrame: filters by requires, keeping the base frame if all fail', () => {
  const cursor = makeRotationCursor();
  const frames = [{ details: 'base' }, { details: 'gated', requires: ['x'] }];
  const framePasses = (f) => !(f.requires && f.requires.length); // only the base passes
  const f = selectFrame(frames, {}, 'idle', cursor, 12000, framePasses, 0);
  assert.equal(f.details, 'base', 'gated frame dropped, base survives');
});

test('selectFrame: resets the cursor on a status transition', () => {
  const cursor = makeRotationCursor();
  // Advance within idle...
  let now = 0;
  selectFrame([{ details: 'a' }, { details: 'b' }], {}, 'idle', cursor, 10, pass, now);
  now += 100;
  selectFrame([{ details: 'a' }, { details: 'b' }], {}, 'idle', cursor, 10, pass, now);
  assert.equal(cursor.index, 1, 'advanced within idle');
  // ...switching to working resets to the base frame.
  const f = selectFrame([{ details: 'work' }], {}, 'working', cursor, 10, pass, now + 100);
  assert.equal(cursor.index, 0);
  assert.equal(cursor.status, 'working');
  assert.equal(f.details, 'work');
});

// ── resolveLargeImageKey ───────────────────────────────────────────────
test('resolveLargeImageKey: statusAssets > modelAssets > global', () => {
  const config = {
    statusAssets: { working: 'work-gif' },
    modelAssets: { opus: 'opus-art', sonnet: 'sonnet-art', default: 'default-art' },
  };
  const p = { largeImageKey: 'global' };
  // statusAssets wins.
  assert.equal(resolveLargeImageKey(config, p, 'working', 'claude-opus-4-8'), 'work-gif');
  // no statusAssets entry → modelAssets by tier.
  assert.equal(resolveLargeImageKey(config, p, 'idle', 'claude-opus-4-8'), 'opus-art');
  assert.equal(resolveLargeImageKey(config, p, 'idle', 'claude-sonnet-4-6'), 'sonnet-art');
  // unknown model tier → modelAssets.default.
  assert.equal(resolveLargeImageKey(config, p, 'idle', 'mystery'), 'default-art');
});

test('resolveLargeImageKey: never uses model art when stale; global fallback', () => {
  const config = { modelAssets: { opus: 'opus-art' } };
  assert.equal(resolveLargeImageKey(config, { largeImageKey: 'global' }, 'stale', 'claude-opus-4-8'), 'global');
  assert.equal(resolveLargeImageKey({}, { largeImageKey: 'global' }, 'idle', 'claude-opus-4-8'), 'global');
  assert.equal(resolveLargeImageKey({}, {}, 'idle', null), null);
});
