// CLI config-writer smoke tests.
//
// Every config-mutating command (`profile set`, `community on/off`, `link`, …)
// routes through writeUserConfig. v0.17.0 shipped that helper calling ITSELF
// instead of writeFileSync — infinite recursion — so each of those commands
// stack-overflowed and never persisted, and nothing caught it: cli.js has zero
// exports and runs main() on import, so there was no unit-level seam.
//
// We exercise the real binary instead. In a dev clone CONFIG_PATH is
// ROOT/config.json (paths.js: ROOT = src/..), which would be the developer's
// own config — so we run from a throwaway copy of src/ whose ROOT, and
// therefore CONFIG_PATH, lives under a temp dir. version.js falls back to its
// BAKED version when package.json lacks a version field, so a minimal
// {"type":"module"} manifest (needed for ESM resolution) is enough.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-cli-'));
  cpSync(join(REPO, 'src'), join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  return dir;
}

function runCli(dir, args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(dir, 'src', 'cli.js'), ...args], {
      env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('close', (code) => resolve({ code, out, err }));
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

test('cli: `profile set` persists config without recursing (writeUserConfig regression)', async (t) => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { code, out, err } = await runCli(dir, ['profile', 'set', '--name', 'Tester']);

  // The recursion crash exited non-zero with a "Maximum call stack" RangeError.
  assert.equal(code, 0, `exited ${code}\nstdout:\n${out}\nstderr:\n${err}`);
  assert.doesNotMatch(err, /Maximum call stack/i, 'writeUserConfig recursed');
  assert.match(out, /profile saved/);

  const cfgPath = join(dir, 'config.json');
  assert.ok(existsSync(cfgPath), 'config.json was written');
  const raw = readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(raw); // valid JSON
  assert.equal(cfg.profile.displayName, 'Tester');
});

test('cli: a second config write merges, not clobbers (config dir already exists)', async (t) => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await runCli(dir, ['profile', 'set', '--name', 'First']);
  const { code } = await runCli(dir, ['profile', 'set', '--handle', 'second-handle']);
  assert.equal(code, 0);

  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(cfg.profile.displayName, 'First', 'prior field survived the second write');
  assert.equal(cfg.profile.handle, 'second-handle');
});
