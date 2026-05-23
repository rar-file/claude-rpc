// VERSION is the user-visible version string. It's read from package.json
// at runtime in dev/npm modes and falls back to a BAKED constant in
// src/version.js for SEA builds (which don't ship package.json on disk).
// These tests pin that the constant matches package.json — drift is the
// only bug worth catching here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { VERSION } = await import('../src/version.js');

test('VERSION matches package.json version (dev/npm mode)', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(VERSION, pkg.version, 'src/version.js and package.json must agree');
});

test('VERSION is a semver-ish string', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+/, 'looks like a version');
});

// BAKED is the SEA-only fallback. We can't easily import it in isolation
// (the module returns the resolved VERSION), but we can grep the source —
// if BAKED drifts from package.json, the SEA build will ship a stale
// number. The grep-test catches that without re-running the build.
test('BAKED fallback in src/version.js matches package.json', () => {
  const src = readFileSync(join(ROOT, 'src', 'version.js'), 'utf8');
  const m = src.match(/const BAKED = '([^']+)';/);
  assert.ok(m, 'BAKED constant declaration must exist');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(m[1], pkg.version, 'bump BAKED in src/version.js when bumping package.json');
});
