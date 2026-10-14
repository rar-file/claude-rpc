// Every local file the dashboard main/preload process require()s must be in
// electron-builder's build.files allowlist, or it is missing from app.asar and
// the packaged app dies on launch (issue #39: port.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const dir = new URL('../dashboard/', import.meta.url);
const { build } = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));

test('dashboard: every local require() is packaged in build.files', () => {
  const missing = [];
  for (const entry of ['main.js', 'preload.js']) {
    const src = readFileSync(new URL(entry, dir), 'utf8');
    for (const [, rel] of src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
      const file = rel.endsWith('.js') || rel.endsWith('.json') ? rel : `${rel}.js`;
      if (!build.files.includes(file)) missing.push(`${entry} → ${file}`);
    }
  }
  assert.deepEqual(missing, [], 'add these to dashboard/package.json build.files');
});

// The settings GUI shows defaults merged with the user's file. The packaged
// app reads DEFAULT_CONFIG from resources/default-config.mjs, so the build
// must copy src/default-config.js there.
test('dashboard: the DEFAULT_CONFIG main.js loads from resources is shipped by extraResources', () => {
  const main = readFileSync(new URL('main.js', dir), 'utf8');
  assert.match(main, /resourcesPath, 'default-config\.mjs'/);
  const entry = (build.extraResources || []).find((r) => r.to === 'default-config.mjs');
  assert.equal(entry?.from, '../src/default-config.js');
});
