// Single source of truth for the user-visible version string.
//
// Read from package.json at module load (works in dev + npm-installed
// modes). For packaged SEA exes, package.json isn't shipped — `npm run
// build:exe` snapshots whatever package.json holds at build time and
// the BAKED fallback below catches the SEA-only "package.json missing"
// case. Bump BAKED when cutting a release; the test in
// test/version.test.js asserts the two stay in sync.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './paths.js';

const BAKED = '0.20.4';

function readPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string') return pkg.version;
  } catch {
    // package.json not on disk (SEA exe) or unreadable — fall back to BAKED.
  }
  return BAKED;
}

export const VERSION = readPkgVersion();
