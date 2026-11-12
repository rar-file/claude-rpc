// Every local file the desktop app's main process require()s must be in
// electron-builder's build.files allowlist, or it is missing from app.asar and
// the packaged app dies on launch (issue #39: port.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const dir = new URL('../dashboard/', import.meta.url);
const { build } = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8'));

test('dashboard: every local require() is packaged in build.files', () => {
  const missing = [];
  const src = readFileSync(new URL('main.js', dir), 'utf8');
  for (const [, rel] of src.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g)) {
    const file = rel.endsWith('.js') || rel.endsWith('.json') ? rel : `${rel}.js`;
    if (!build.files.includes(file)) missing.push(`main.js → ${file}`);
  }
  assert.deepEqual(missing, [], 'add these to dashboard/package.json build.files');
});

test('dashboard: everything in build.files exists', () => {
  for (const f of build.files) assert.ok(existsSync(new URL(f, dir)), `${f} is listed but missing`);
});

// The desktop app is a shell around the CLI's own /settings page. It must not
// grow its own UI or a privileged bridge into the page again: the page is
// served over HTTP by a local process and gets no Node or IPC access.
test('dashboard: the window shows the CLI settings page with no preload or IPC', () => {
  const main = readFileSync(new URL('main.js', dir), 'utf8');
  assert.match(main, /loadURL\(`\$\{baseUrl\(\)\}\/settings`\)/);
  assert.doesNotMatch(main, /preload\s*:/);
  assert.doesNotMatch(main, /ipcMain/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /contextIsolation: true/);
});

// The page the window loads has to exist in the CLI the app bundles.
test('dashboard: the CLI serves /settings and its assets ship in the binary', () => {
  const index = readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8');
  assert.match(index, /\['\/settings', SETTINGS_HTML\]/);
  const sea = JSON.parse(readFileSync(new URL('../sea-config.json', import.meta.url), 'utf8'));
  for (const a of ['settings.html', 'settings.css', 'settings.client.js']) {
    assert.ok(sea.assets[a], `${a} missing from sea-config.json assets`);
    assert.ok(existsSync(new URL(`../${sea.assets[a]}`, import.meta.url)), `${sea.assets[a]} missing on disk`);
  }
});
