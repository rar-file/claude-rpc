// Stages dist/claude-rpc[.exe] into dashboard/resources/bin/ so
// electron-builder's extraResources picks it up. Run before any
// `electron-builder` command in the dashboard.
//
// The exe must already exist — produce it first with `npm run build:exe`.
// We don't run it from here on purpose: cross-platform builds run the SEA
// step in a job that's pinned to the matching OS, and we want this script
// to be a fast pre-flight check rather than a 30-second rebuild.

import { existsSync, mkdirSync, copyFileSync, chmodSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const isWin = process.platform === 'win32';
const binName = isWin ? 'claude-rpc.exe' : 'claude-rpc';

const src = join(ROOT, 'dist', binName);
const destDir = join(ROOT, 'dashboard', 'resources', 'bin');
const dest = join(destDir, binName);

if (!existsSync(src)) {
  console.error(`✗ ${src} not found — run \`npm run build:exe\` first.`);
  process.exit(1);
}

// Wipe stale binaries from prior platform builds (e.g. a .exe left behind
// on a Mac runner) so the .dmg doesn't ship the wrong arch's binary.
if (existsSync(destDir)) {
  for (const name of readdirSync(destDir)) {
    if (name !== binName) {
      try { rmSync(join(destDir, name)); } catch {}
    }
  }
} else {
  mkdirSync(destDir, { recursive: true });
}

copyFileSync(src, dest);
if (!isWin) chmodSync(dest, 0o755);

console.log(`✓ staged ${binName} → ${dest}`);
