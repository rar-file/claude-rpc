// The settings window reaches the main process only through preload.js's
// window.api. Electron can't run under `npm test`, so these checks read the
// three files as text. Every exposed call must be used by renderer.js and
// handled by main.js, and every main → renderer message must have a listener.
// This catches a renamed channel, and unused plumbing creeping back (audit:
// pickConfig, checkForUpdates and onUpdateEvent were exposed but never used).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../dashboard/${f}`, import.meta.url), 'utf8');
const main = read('main.js');
const preload = read('preload.js');
const renderer = read('renderer.js');
const all = (src, re) => [...src.matchAll(re)].map((m) => m[1]);

const exposed = all(preload, /^\s*(\w+):\s*\(/gm);
const invoked = all(preload, /ipcRenderer\.invoke\('([\w-]+)'/g);
const listened = all(preload, /ipcRenderer\.on\('([\w-]+)'/g);
const handled = all(main, /ipcMain\.handle\('([\w-]+)'/g);
const sent = all(main, /sendToRenderer\('([\w-]+)'/g);
const used = new Set(all(renderer, /window\.api\.(\w+)/g));

test('dashboard IPC: renderer uses only what preload exposes, and all of it', () => {
  assert.ok(exposed.length > 10, 'parsed the preload API');
  assert.deepEqual(
    [...used].filter((n) => !exposed.includes(n)),
    [],
    'used but not exposed',
  );
  assert.deepEqual(
    exposed.filter((n) => !used.has(n)),
    [],
    'exposed but never used',
  );
});

test('dashboard IPC: every invoke has a handler in main, and every handler is invoked', () => {
  assert.deepEqual(
    invoked.filter((c) => !handled.includes(c)),
    [],
    'invoked but not handled',
  );
  assert.deepEqual(
    handled.filter((c) => !invoked.includes(c)),
    [],
    'handled but never invoked',
  );
});

test('dashboard IPC: every main → renderer message has a listener, and vice versa', () => {
  assert.deepEqual(
    sent.filter((c) => !listened.includes(c)),
    [],
    'sent but nobody listens',
  );
  assert.deepEqual(
    listened.filter((c) => !sent.includes(c)),
    [],
    'listened for but never sent',
  );
});
