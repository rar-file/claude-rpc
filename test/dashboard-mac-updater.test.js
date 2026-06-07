// Regression test for issue #11: macOS auto-update silently does nothing when
// the mac build target is dmg-only.  electron-updater's MacUpdater can only
// apply updates from a .zip artifact referenced by latest-mac.yml; electron-
// builder emits that feed file only when a zip target is present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dashPkg = JSON.parse(readFileSync(join(ROOT, 'dashboard', 'package.json'), 'utf8'));

test('dashboard mac targets include zip (required for latest-mac.yml updater feed)', () => {
  const macTargets = dashPkg.build?.mac?.target ?? [];
  const targetNames = macTargets.map(t => (typeof t === 'string' ? t : t.target));
  assert.ok(
    targetNames.includes('zip'),
    'dashboard/package.json mac.target must include "zip" — without it electron-builder ' +
    'never emits latest-mac.yml and auto-update silently does nothing on macOS',
  );
});

test('dashboard dist:mac script includes zip target', () => {
  const distMac = dashPkg.scripts?.['dist:mac'] ?? '';
  assert.ok(
    distMac.includes('zip'),
    'dashboard/package.json scripts.dist:mac must pass "zip" to electron-builder ' +
    'so local builds produce the same updater feed as CI',
  );
});
