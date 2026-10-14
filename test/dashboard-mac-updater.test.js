// Regression test for issue #11: macOS auto-update silently does nothing when
// the mac build target is dmg-only.  electron-updater's MacUpdater can only
// apply updates from a .zip artifact listed in latest-mac.yml. A dmg-only
// build still writes latest-mac.yml, but with the .dmg as its only file, so
// the updater finds a new version and then can't install it.

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
    'dashboard/package.json mac.target must include "zip" — without it latest-mac.yml ' +
    'lists only the .dmg and auto-update silently does nothing on macOS',
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

// The release workflow is what actually ships. Targets given on the
// electron-builder command line REPLACE package.json's mac.target, so a CI
// step running `electron-builder --mac dmg` silently drops the zip (leaving a
// dmg-only latest-mac.yml) no matter what package.json says — which is
// exactly how v1.5.2 and earlier shipped. The artifact globs must also carry
// the zip and the feed file through to the GitHub Release.
const releaseYml = readFileSync(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');

test('release.yml builds the mac zip target', () => {
  const macBuilds = releaseYml
    .split('\n')
    .filter((l) => /electron-builder\b.*--mac\b/.test(l) && !l.trim().startsWith('#'));
  assert.ok(macBuilds.length > 0, 'release.yml must run electron-builder --mac');
  for (const line of macBuilds) {
    // `--mac` followed by explicit targets overrides package.json; `--mac`
    // alone defers to it (covered by the first test above).
    const targets = (line.match(/--mac((?:\s+[a-z0-9]+)*)/)?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
    assert.ok(
      targets.length === 0 || (targets.includes('zip') && targets.includes('dmg')),
      `release.yml mac build must produce both dmg and zip (got: ${line.trim()})`,
    );
  }
});

test('release.yml ships the mac zip and latest*.yml feed files', () => {
  assert.match(releaseYml, /dashboard\/dist\/\*\.zip/, 'mac dist-glob must include dashboard/dist/*.zip');
  assert.match(releaseYml, /dashboard\/dist\/latest\*\.yml/, 'dist-glob must include dashboard/dist/latest*.yml');
  assert.match(releaseYml, /-name '\*\.zip'/, 'the release flatten step must copy *.zip');
  assert.match(releaseYml, /-name 'latest\*\.yml'/, 'the release flatten step must copy latest*.yml');
  // A bare *.yml glob also picks up electron-builder's builder-debug.yml,
  // which is not a feed file and collides between the mac and win jobs.
  assert.doesNotMatch(releaseYml, /dashboard\/dist\/\*\.yml/, 'use latest*.yml, not *.yml (builder-debug.yml)');
  assert.doesNotMatch(releaseYml, /-name '\*\.yml'/, "flatten must match 'latest*.yml', not '*.yml'");
});
