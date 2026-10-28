import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewer, sameMajor, installKind, planUpdate, checkForUpdate, readUpdateState, installVersion } from '../src/updater.js';

test('isNewer: numeric compare, ignores prereleases and junk', () => {
  assert.ok(isNewer('1.10.0', '1.9.9'));
  assert.ok(isNewer('1.6.1', '1.6.0'));
  assert.ok(!isNewer('1.6.0', '1.6.0'));
  assert.ok(!isNewer('1.5.9', '1.6.0'));
  assert.ok(!isNewer('2.0.0-beta.1', '1.6.0'));
  assert.ok(!isNewer(null, '1.6.0'));
});

test('installKind: classifies how this copy was installed', () => {
  assert.equal(installKind({ packaged: true, npm: false, npx: false, root: '/x' }), 'packaged');
  assert.equal(installKind({ packaged: false, npm: true, npx: true, root: '/x/_npx/y' }), 'npx');
  assert.equal(installKind({ packaged: false, npm: true, npx: false, root: '/opt/Cellar/claude-rpc/1/lib/node_modules/claude-rpc' }), 'brew');
  assert.equal(installKind({ packaged: false, npm: true, npx: false, root: '/usr/lib/node_modules/claude-rpc' }), 'npm-global');
  assert.equal(installKind({ packaged: false, npm: false, npx: false, root: '/home/me/claude-rpc' }), 'dev');
});

test('planUpdate: installs only same-major, npm-global, auto-on, not recently failed', () => {
  const base = { current: '1.6.0', latest: '1.6.1', auto: true, kind: 'npm-global', cooldownMs: 0 };
  assert.equal(planUpdate(base).action, 'install');
  assert.equal(planUpdate({ ...base, latest: '1.6.0' }).action, 'none');
  assert.equal(planUpdate({ ...base, auto: false }).action, 'notify');
  assert.equal(planUpdate({ ...base, kind: 'brew' }).action, 'notify');
  assert.equal(planUpdate({ ...base, latest: '2.0.0' }).action, 'notify');
  const now = 1_000_000;
  assert.equal(planUpdate({ ...base, now, failed: { version: '1.6.1', at: now - 1000 } }).action, 'notify');
  assert.equal(planUpdate({ ...base, now: now + 25 * 3_600_000, failed: { version: '1.6.1', at: now } }).action, 'install');
  assert.equal(planUpdate({ ...base, now, failed: { version: '1.6.0', at: now - 1000 } }).action, 'install', 'a different version is retried');
});

test('checkForUpdate: installs a newer release, records it; failure is remembered', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'upd-')), 'update.json');
  const calls = [];
  const ok = await checkForUpdate({ current: '1.6.0', auto: true, kind: 'npm-global', statePath, cooldownMs: 0,
    fetchLatestFn: async () => '1.6.1', install: async (v) => { calls.push(v); return { ok: true, output: '' }; } });
  assert.equal(ok.installed, true);
  assert.deepEqual(calls, ['1.6.1']);
  assert.equal(readUpdateState(statePath).updatedTo, '1.6.1');

  const bad = await checkForUpdate({ current: '1.6.0', auto: true, kind: 'npm-global', statePath, cooldownMs: 0,
    fetchLatestFn: async () => '1.6.2', install: async () => ({ ok: false, output: 'EACCES' }) });
  assert.equal(bad.installed, false);
  assert.match(bad.error, /EACCES/);
  assert.equal(readUpdateState(statePath).failed.version, '1.6.2');
  // second attempt within the window does not call install again
  let again = 0;
  await checkForUpdate({ current: '1.6.0', auto: true, kind: 'npm-global', statePath, cooldownMs: 0,
    fetchLatestFn: async () => '1.6.2', install: async () => { again++; return { ok: true, output: '' }; } });
  assert.equal(again, 0);
});

test('checkForUpdate: registry unreachable is a quiet no-op', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'upd-')), 'update.json');
  const r = await checkForUpdate({ current: '1.6.0', auto: true, kind: 'npm-global', statePath, cooldownMs: 0, fetchLatestFn: async () => null });
  assert.equal(r.plan.action, 'none');
  assert.equal(r.installed, false);
});

test('installVersion: refuses anything that is not a plain x.y.z (shell-safe)', async () => {
  const r = await installVersion('1.6.1; rm -rf /');
  assert.equal(r.ok, false);
});

test('cooldown: a new release is only installed after it has been seen for the cooldown', async () => {
  const statePath = join(mkdtempSync(join(tmpdir(), 'upd-')), 'update.json');
  let installs = 0;
  const run = (now) => checkForUpdate({ current: '1.6.0', auto: true, kind: 'npm-global', statePath, now, cooldownMs: 2 * 3_600_000,
    fetchLatestFn: async () => '1.6.1', install: async () => { installs++; return { ok: true, output: '' }; } });
  const t0 = 1_000_000;
  assert.equal((await run(t0)).installed, false);                    // first sighting
  assert.equal((await run(t0 + 3_600_000)).installed, false);        // 1h: still settling
  assert.equal((await run(t0 + 2 * 3_600_000)).installed, true);     // 2h: go
  assert.equal(installs, 1);
});
