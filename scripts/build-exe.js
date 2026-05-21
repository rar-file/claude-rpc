// Builds a single-file claude-rpc binary via Node SEA (Single Executable Apps).
// Cross-platform: produces dist/claude-rpc.exe on Windows and dist/claude-rpc
// on macOS / Linux. Same SEA pipeline either way — only the postject sentinel
// flags and post-build signature handling differ.
//
// Pipeline:
//   1. esbuild bundles bin/claude-rpc.js → dist/bundle.cjs (CJS, single file)
//   2. node --experimental-sea-config sea-config.json → dist/sea-prep.blob
//   3. copy the running node binary → dist/claude-rpc[.exe]
//   4. postject injects the SEA blob into the copied binary
//        - macOS needs --macho-segment-name NODE_SEA so the segment doesn't
//          collide with anything codesign-related
//   5. fix up the signature:
//        - Windows: strip invalid Authenticode (signtool, if present) so AV
//          doesn't get suspicious of a broken "signed" binary
//        - macOS: codesign --remove-signature, then re-sign ad-hoc — Apple
//          *requires* a valid signature (even adhoc) for the binary to run
//
// SEA exes are far less likely than pkg ones to trigger AV false positives
// because they are literally Node.js with a blob appended — no third-party
// loader code, no bytecode patterns AV products have learned to flag.

import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, statSync, rmSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
process.chdir(ROOT);

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const exeName = isWin ? 'claude-rpc.exe' : 'claude-rpc';
const exeOut = `dist/${exeName}`;
const seaBlob = 'dist/sea-prep.blob';

function run(label, cmd) {
  console.log(`\n→ ${label}`);
  execSync(cmd, { stdio: 'inherit', shell: true });
}

function tryRun(label, cmd) {
  try {
    execSync(cmd, { stdio: 'pipe', shell: true });
    console.log(`  ✓ ${label}`);
    return true;
  } catch {
    console.log(`  · ${label} skipped`);
    return false;
  }
}

mkdirSync('dist', { recursive: true });
if (existsSync(exeOut)) rmSync(exeOut);
if (existsSync(seaBlob)) rmSync(seaBlob);

run(
  '1/4  esbuild bundle',
  `npx esbuild bin/claude-rpc.js --bundle --platform=node --target=node20 --format=cjs --outfile=dist/bundle.cjs --banner:js="const __filename_url=require('url').pathToFileURL(__filename).toString();" --define:import.meta.url=__filename_url`
);

run(
  '2/4  SEA blob',
  `node --experimental-sea-config sea-config.json`
);

console.log(`\n→ 3/4  Copy ${process.execPath} → ${exeOut}`);
copyFileSync(process.execPath, exeOut);
if (!isWin) chmodSync(exeOut, 0o755);

const sentinel = '--sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const machoFlags = isMac ? '--macho-segment-name NODE_SEA' : '';
run(
  '4/4  Inject blob into binary',
  `npx postject ${exeOut} NODE_SEA_BLOB ${seaBlob} ${sentinel} ${machoFlags}`.trim()
);

// Per-platform signature fixup.
if (isWin) {
  // Invalid Authenticode (inherited from node.exe) spooks some AV — strip it.
  if (tryRun('Stripped invalid Authenticode signature', `signtool remove /s "${exeOut}"`)) {
    // ok
  } else {
    console.log('  (signtool not available — leaving invalid signature; exe still runs)');
  }
} else if (isMac) {
  // macOS *requires* a valid signature. Inherited signature from /usr/bin/node
  // is broken once we mutate the binary, so remove it and re-sign ad-hoc.
  // Ad-hoc means "no developer ID" — users still need to right-click → Open
  // the first time, but the binary will at least *run*.
  tryRun('Removed inherited signature', `codesign --remove-signature "${exeOut}"`);
  tryRun('Ad-hoc re-signed', `codesign --sign - --force --options runtime --timestamp=none "${exeOut}"`);
}

const size = statSync(exeOut).size;
console.log(`\n✓ ${exeOut} ready (${(size / 1024 / 1024).toFixed(1)} MB)`);
