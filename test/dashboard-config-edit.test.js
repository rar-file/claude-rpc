// dashboard/config-edit.js: the settings GUI shows defaults merged with the
// user's config.json, and on save writes back only what the user changed.
//
// Regression (audit B9): the GUI used to load the raw two-line config, show no
// buttons, and on any Save write `presence.buttons: []`. Arrays replace on
// merge, so that silently deleted the default "Get claude-rpc →" button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/default-config.js';
import { mergeConfig as srcMergeConfig } from '../src/config.js';

const require = createRequire(import.meta.url);
const { mergeConfig, applyEdits, deepEqual } = require('../dashboard/config-edit.js');

const EXAMPLE = JSON.parse(
  readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'),
);
const clone = (v) => structuredClone(v);

// What the GUI shows for a given file: defaults + overrides.
const viewOf = (raw) => mergeConfig(DEFAULT_CONFIG, raw);

test('mergeConfig matches src/config.js (objects merge, arrays replace)', () => {
  const overrides = [
    {},
    EXAMPLE,
    { presence: { buttons: [] } },
    { presence: { buttons: [{ label: 'Mine', url: 'https://example.com' }], githubButton: false } },
    { statusIcons: { working: '' }, goals: { dailyHours: 4 }, triggers: [{ match: 'npm test' }] },
    { presence: null, extra: { nested: [1, 2] } },
  ];
  for (const over of overrides) {
    assert.deepEqual(mergeConfig(DEFAULT_CONFIG, over), srcMergeConfig(DEFAULT_CONFIG, over));
  }
});

test('B9: saving an untouched fresh config writes nothing new, so the default button survives', () => {
  const raw = clone(EXAMPLE);
  const shown = viewOf(raw);
  assert.deepEqual(
    shown.presence.buttons,
    DEFAULT_CONFIG.presence.buttons,
    'GUI shows the default button',
  );

  const saved = applyEdits(raw, shown, clone(shown));
  assert.deepEqual(saved, raw, 'file content unchanged');
  assert.equal('presence' in saved, false);
  assert.deepEqual(viewOf(saved).presence.buttons, DEFAULT_CONFIG.presence.buttons);
});

test('B9: an empty field the GUI only displayed is not written, even without defaults loaded', () => {
  // Fallback path: defaults unavailable, so the form shows the raw file and
  // collects `buttons: []` before and after. Nothing changed, nothing written.
  const raw = clone(EXAMPLE);
  const pristine = {
    ...clone(raw),
    presence: { buttons: [], rotation: [] },
    statusIcons: { working: '' },
  };
  const saved = applyEdits(raw, pristine, clone(pristine));
  assert.deepEqual(saved, raw);
});

test('only the edited key is written', () => {
  const raw = clone(EXAMPLE);
  const shown = viewOf(raw);
  const edited = clone(shown);
  edited.appName = 'My Editor';
  assert.deepEqual(applyEdits(raw, shown, edited), { ...raw, appName: 'My Editor' });
});

test('editing a button writes the whole buttons array and nothing else under presence', () => {
  const raw = clone(EXAMPLE);
  const shown = viewOf(raw);
  const edited = clone(shown);
  edited.presence.buttons = [{ label: 'Portfolio', url: 'https://me.dev' }];
  const saved = applyEdits(raw, shown, edited);
  assert.deepEqual(saved.presence, { buttons: [{ label: 'Portfolio', url: 'https://me.dev' }] });
  assert.equal(saved.clientId, raw.clientId);
});

test('removing every button on purpose writes an empty array', () => {
  const raw = clone(EXAMPLE);
  const shown = viewOf(raw);
  const edited = clone(shown);
  edited.presence.buttons = [];
  assert.deepEqual(applyEdits(raw, shown, edited).presence, { buttons: [] });
});

test('a nested edit writes just that leaf', () => {
  const raw = { clientId: '1', statusIcons: { idle: 'zzz' } };
  const shown = viewOf(raw);
  const edited = clone(shown);
  edited.statusIcons.working = 'hammer';
  assert.deepEqual(applyEdits(raw, shown, edited).statusIcons, { idle: 'zzz', working: 'hammer' });
});

test('a cleared field (key removed by the GUI) is deleted, so the default applies', () => {
  const raw = { clientId: '1', updateIntervalMs: 9000 };
  const shown = viewOf(raw);
  const edited = clone(shown);
  delete edited.updateIntervalMs;
  const saved = applyEdits(raw, shown, edited);
  assert.equal('updateIntervalMs' in saved, false);
  assert.equal(viewOf(saved).updateIntervalMs, DEFAULT_CONFIG.updateIntervalMs);
});

test('clearing a field that only had a default leaves the file alone (no empty {} left behind)', () => {
  const raw = { clientId: '1' };
  const shown = viewOf(raw);
  const edited = clone(shown);
  delete edited.rotationIntervalMs;
  delete edited.goals.dailyHours;
  assert.deepEqual(applyEdits(raw, shown, edited), raw);
});

test('keys written to the file after the GUI loaded it survive a save', () => {
  const rawAtLoad = { clientId: '1' };
  const shown = viewOf(rawAtLoad);
  const edited = clone(shown);
  edited.showElapsed = false;
  // Meanwhile the CLI wrote these (e.g. `claude-rpc community on`, `badge --gist`).
  const rawNow = {
    ...rawAtLoad,
    community: { enabled: true, instanceId: 'abc' },
    gist: { id: 'g1' },
  };
  assert.deepEqual(applyEdits(rawNow, shown, edited), { ...rawNow, showElapsed: false });
});

test('inputs are not mutated, key order does not count as a change', () => {
  const raw = { clientId: '1', _comment: 'keep me' };
  const shown = viewOf(raw);
  const edited = clone(shown);
  edited.goals = { weeklyHours: 0, dailyPrompts: 0, dailyHours: 0 }; // same values, other order
  const snapshot = clone([raw, shown, edited]);
  assert.deepEqual(applyEdits(raw, shown, edited), raw);
  assert.deepEqual([raw, shown, edited], snapshot);
});

test('a non-object file is treated as empty', () => {
  assert.deepEqual(applyEdits(null, { a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(applyEdits([], {}, { a: 1 }), { a: 1 });
});

test('deepEqual', () => {
  assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual({ a: undefined }, {}), false);
  assert.equal(deepEqual([], {}), false);
  assert.equal(deepEqual(0, ''), false);
});
