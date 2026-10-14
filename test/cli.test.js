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
import { cpSync, mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
      // TMPDIR too: the state dir (and legacy file locations some commands
      // migrate from) live under os.tmpdir(), never the developer's real one.
      env: {
        ...process.env, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir,
        TMPDIR: join(dir, 'tmp'), TMP: join(dir, 'tmp'), TEMP: join(dir, 'tmp'),
        CLAUDE_RPC_NO_AUTOSTART: '1', NO_COLOR: '1',
      },
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

test('cli: config writes are atomic (tmp + rename) — no partial or leftover tmp file', async (t) => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code } = await runCli(dir, ['profile', 'set', '--name', 'Atomic']);
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).profile.displayName, 'Atomic');
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('config.json')), ['config.json'], 'no config.json.<pid>.tmp left behind');
});

test('cli: `community on` with a freshly minted id records a zero cursor (first flush sends history)', async (t) => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ community: { enabled: false } }));
  const { code, out, err } = await runCli(dir, ['community', 'on'], { input: 'y\n' });
  assert.equal(code, 0, out + err);
  const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(cfg.community.enabled, true);
  assert.match(cfg.community.instanceId, /^[0-9a-f-]{36}$/);
  const cursor = JSON.parse(readFileSync(join(dir, '.claude-rpc', 'community-cursor.json'), 'utf8'));
  assert.deepEqual(cursor, { sessions: 0, tokens: 0, ts: 0 });
});

test('cli: `community on` re-enabling a kept id leaves the cursor alone', async (t) => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ community: { enabled: false, instanceId: '12345678-1234-4abc-abcd-1234567890ab' } }));
  const { code } = await runCli(dir, ['community', 'on'], { input: 'y\n' });
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, '.claude-rpc', 'community-cursor.json')), false,
    'no zero cursor: this id may already have reported (the flush seeds or adopts instead)');
});

test('cli: `wrapped --publish --year` validates the value; `--year=N` works', async (t) => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    profile: { handle: 'tester', enabled: true },
    community: { enabled: false, instanceId: '12345678-1234-4abc-abcd-1234567890ab', endpoint: 'http://127.0.0.1:9' },
  }));
  mkdirSync(join(dir, '.claude-rpc'), { recursive: true });
  writeFileSync(join(dir, '.claude-rpc', 'aggregate.json'), JSON.stringify({ sessions: 1, byDay: { '2025-03-01': { activeMs: 3_600_000 } } }));

  // No value: used to print "Claude Wrapped NaN" and carry on.
  const bare = await runCli(dir, ['wrapped', '--publish', '--year']);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /--year needs a value/);
  assert.doesNotMatch(bare.out, /NaN/);

  const flagNext = await runCli(dir, ['wrapped', '--publish', '--year', '--yes']);
  assert.equal(flagNext.code, 1, 'a flag is not a year — and must not publish');
  assert.match(flagNext.err, /--year needs a value/);

  const junk = await runCli(dir, ['wrapped', '--publish', '--year', 'abc']);
  assert.equal(junk.code, 1);
  assert.match(junk.err, /4-digit year/);

  // `--year=2025` used to be ignored (published the current year). Non-TTY
  // without --yes stops at the confirmation, after the preview header.
  const eq = await runCli(dir, ['wrapped', '--publish', '--year=2025']);
  assert.match(eq.out, /Claude Wrapped 2025/);
  assert.match(eq.err, /refusing to publish without confirmation/);
  const spaced = await runCli(dir, ['wrapped', '--publish', '--year', '2025']);
  assert.match(spaced.out, /Claude Wrapped 2025/);
});

test('cli: help lists every user-facing command, including aliases', async (t) => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, out } = await runCli(dir, ['help']);
  assert.equal(code, 0);
  const names = out.split('\n').map((l) => l.trim().split(/\s{2,}/)[0]);
  for (const name of ['setup', 'install', 'status', 'dump', 'vars', 'pause', 'pause status|off', 'resume', 'unpause', 'tail', 'logs']) {
    assert.ok(names.includes(name), `help lists \`${name}\``);
  }
  assert.doesNotMatch(out, /Windows startup entry/, 'autostart is cross-platform now');
  assert.match(out, /LaunchAgent/);
});

test('cli: projects/project/compare run clean with no aggregate (v1.2)', async (t) => {
  // A fresh sandbox has no aggregate.json — all three must print a friendly
  // pointer (not crash), and `project` without/with an unknown name is a
  // usage error (non-zero exit).
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const projects = await runCli(dir, ['projects']);
  assert.equal(projects.code, 0, projects.err);
  assert.match(projects.out, /No project data yet/);

  const compare = await runCli(dir, ['compare']);
  assert.equal(compare.code, 0, compare.err);
  assert.match(compare.out, /No history yet/);

  const bare = await runCli(dir, ['project']);
  assert.notEqual(bare.code, 0, 'project without a name exits non-zero');
  assert.match(bare.out, /Usage:/);

  const miss = await runCli(dir, ['project', 'nope']);
  assert.notEqual(miss.code, 0);
  assert.match(miss.out, /No project matching/);
});
