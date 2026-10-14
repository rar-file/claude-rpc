// Static checks on the settings window's renderer (a browser-only script, so
// it is read as text rather than imported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/default-config.js';

const read = (f) => readFileSync(new URL(`../dashboard/${f}`, import.meta.url), 'utf8');
const renderer = read('renderer.js');

test('Assets tab lists every status the daemon renders', () => {
  const m = renderer.match(/const STATUSES = \[([^\]]*)\]/);
  assert.ok(m, 'STATUSES array found in renderer.js');
  const listed = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort();
  const daemon = [
    ...new Set([
      ...Object.keys(DEFAULT_CONFIG.statusAssets),
      ...Object.keys(DEFAULT_CONFIG.statusIcons),
    ]),
  ].sort();
  assert.deepEqual(listed, daemon);
});

test('every CSS custom property the dashboard uses is defined in styles.css', () => {
  const css = read('styles.css');
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((x) => x[1]));
  const usedIn = (src) => [...src.matchAll(/var\((--[\w-]+)/g)].map((x) => x[1]);
  const undefinedVars = [
    ...new Set([...usedIn(css), ...usedIn(renderer), ...usedIn(read('index.html'))]),
  ].filter((v) => !defined.has(v));
  assert.deepEqual(undefinedVars, []);
});
