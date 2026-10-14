// Privacy resolution + applyPrivacy. The interesting cases are the
// resolution chain (per-project file > runtime list > config patterns >
// gh-private auto-detect > default) and the three visibility outputs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { applyPrivacy, resolveVisibility } = await import('../src/privacy.js');

function baseState(overrides = {}) {
  return {
    status: 'working',
    cwd: '/home/foo/projects/proj',
    currentFile: 'src/scanner.js',
    currentTool: 'Edit',
    filesEdited: ['/x.js'],
    filesRead: [],
    filesOpened: ['/x.js'],
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    messages: 1,
    ...overrides,
  };
}

test('default visibility is public — no privacy flag set', () => {
  const r = resolveVisibility('/tmp/no-config-here-xyz', {});
  assert.equal(r.visibility, 'public');
  assert.equal(r.reason, 'default');
});

test('config pattern triggers hidden mode', () => {
  const cfg = { privacy: { patterns: ['client-*'], mode: 'hidden', autoDetectGithubPrivate: false } };
  const r = resolveVisibility('/home/foo/work/client-acme', cfg);
  assert.equal(r.visibility, 'hidden');
  assert.match(r.reason, /client-\*/);
});

test('config pattern with mode=name-only honors the chosen mode', () => {
  const cfg = { privacy: { patterns: ['secret'], mode: 'name-only', autoDetectGithubPrivate: false } };
  const r = resolveVisibility('/some/path/secret', cfg);
  assert.equal(r.visibility, 'name-only');
});

test('per-project file wins over global config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-priv-'));
  try {
    writeFileSync(join(dir, '.claude-rpc.json'), JSON.stringify({
      visibility: 'name-only',
      projectName: 'client-acme',
    }));
    const cfg = { privacy: { patterns: ['*'], mode: 'hidden', autoDetectGithubPrivate: false } };
    const r = resolveVisibility(dir, cfg);
    assert.equal(r.visibility, 'name-only', 'per-project file overrides config patterns');
    assert.equal(r.projectName, 'client-acme');
    assert.equal(r.reason, '.claude-rpc.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shortcut: { "private": true } resolves to hidden', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-priv-'));
  try {
    writeFileSync(join(dir, '.claude-rpc.json'), JSON.stringify({ private: true }));
    const r = resolveVisibility(dir, { privacy: { autoDetectGithubPrivate: false } });
    assert.equal(r.visibility, 'hidden');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('broken .claude-rpc.json is ignored gracefully', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-priv-'));
  try {
    writeFileSync(join(dir, '.claude-rpc.json'), '{not valid json');
    const r = resolveVisibility(dir, { privacy: { autoDetectGithubPrivate: false } });
    assert.equal(r.visibility, 'public', 'broken JSON ≡ no override');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyPrivacy: public is a no-op', () => {
  const s = baseState();
  const r = applyPrivacy(s, { privacy: { autoDetectGithubPrivate: false } });
  // No _privacy block, original fields intact.
  assert.equal(r.currentFile, 'src/scanner.js');
  assert.equal(r.currentTool, 'Edit');
});

test('applyPrivacy: name-only clears file/tool but keeps cwd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-priv-'));
  try {
    writeFileSync(join(dir, '.claude-rpc.json'), JSON.stringify({ visibility: 'name-only' }));
    const r = applyPrivacy(baseState({ cwd: dir }), {});
    assert.equal(r._privacy.visibility, 'name-only');
    assert.equal(r.currentTool, null);
    assert.equal(r.currentFile, null);
    assert.deepEqual(r.filesEdited, []);
    assert.equal(r.cwd, dir, 'cwd preserved so {project} still renders');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyPrivacy: hidden clears cwd entirely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-priv-'));
  try {
    writeFileSync(join(dir, '.claude-rpc.json'), JSON.stringify({ private: true }));
    const r = applyPrivacy(baseState({ cwd: dir }), {});
    assert.equal(r._privacy.visibility, 'hidden');
    assert.equal(r.cwd, '');
    assert.equal(r.currentFile, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyPrivacy: projectName aliases the cwd basename for public projects too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-priv-'));
  try {
    writeFileSync(join(dir, '.claude-rpc.json'), JSON.stringify({
      visibility: 'public',
      projectName: 'cool-codename',
    }));
    const r = applyPrivacy(baseState({ cwd: dir }), {});
    // cwd's last segment is replaced with the alias so buildVars's {project}
    // picks it up. File paths and tools still flow through normally.
    assert.match(r.cwd, /cool-codename$/);
    assert.equal(r.currentFile, 'src/scanner.js');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('applyPrivacy: skips stale state', () => {
  const s = baseState({ status: 'stale' });
  const r = applyPrivacy(s, {});
  assert.equal(r, s, 'stale states pass through untouched');
});

// ── Central visibility map (GUI-managed) ────────────────────────────────
// Exercise setCwdVisibility + the new resolveVisibility layer against a
// temp private-list via CLAUDE_RPC_PRIVATE_LIST so the real one is untouched.
// Loaded as a fresh module instance so it picks up the env override.

test('central visibility map: set → resolve → clear', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-vis-'));
  const listPath = join(dir, 'private-list.json');
  process.env.CLAUDE_RPC_PRIVATE_LIST = listPath;
  try {
    const mod = await import('../src/privacy.js?vis=' + Date.now()); // fresh instance
    const proj = join(dir, 'work', 'client-x');

    // Default before any override.
    assert.equal(mod.resolveVisibility(proj, { privacy: { autoDetectGithubPrivate: false } }).visibility, 'public');

    // name-only override resolves and reports its reason.
    mod.setCwdVisibility(proj, 'name-only');
    let r = mod.resolveVisibility(proj, { privacy: { autoDetectGithubPrivate: false } });
    assert.equal(r.visibility, 'name-only');
    assert.match(r.reason, /private-list/);

    // Explicit 'public' wins over a config glob that would otherwise hide it.
    mod.setCwdVisibility(proj, 'public');
    r = mod.resolveVisibility(proj, { privacy: { patterns: ['client-*'], mode: 'hidden', autoDetectGithubPrivate: false } });
    assert.equal(r.visibility, 'public', 'explicit public overrides config-glob hide');

    // Clearing the override falls back through to the config glob.
    mod.setCwdVisibility(proj, null);
    r = mod.resolveVisibility(proj, { privacy: { patterns: ['client-*'], mode: 'hidden', autoDetectGithubPrivate: false } });
    assert.equal(r.visibility, 'hidden', 'cleared override falls through to config pattern');
    assert.deepEqual(mod.listVisibility(), {}, 'map empty after clear');
  } finally {
    delete process.env.CLAUDE_RPC_PRIVATE_LIST;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('central visibility map: subdirectory inherits a marked parent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-vis-'));
  process.env.CLAUDE_RPC_PRIVATE_LIST = join(dir, 'private-list.json');
  try {
    const mod = await import('../src/privacy.js?vis=' + Date.now() + 'b');
    const parent = join(dir, 'repo');
    mod.setCwdVisibility(parent, 'hidden');
    const r = mod.resolveVisibility(join(parent, 'packages', 'sub'), { privacy: { autoDetectGithubPrivate: false } });
    assert.equal(r.visibility, 'hidden', 'subdir inherits parent override');
  } finally {
    delete process.env.CLAUDE_RPC_PRIVATE_LIST;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Pattern case-insensitivity ──────────────────────────────────────────
// Plain (non-glob) patterns used to be compared case-sensitively, and
// projectNameIsPrivate lowercases the name first — so `patterns: ["ClientX"]`
// never matched there and `wrapped --publish` sent "ClientX".

test('plain config patterns match case-insensitively, both directions', () => {
  const cfg = (patterns) => ({ privacy: { patterns, autoDetectGithubPrivate: false } });
  assert.equal(resolveVisibility('/w/ClientX', cfg(['clientx'])).visibility, 'hidden', 'lower pattern vs mixed-case cwd');
  assert.equal(resolveVisibility('/w/clientx', cfg(['ClientX'])).visibility, 'hidden', 'mixed-case pattern vs lower cwd');
  assert.equal(resolveVisibility('/w/clientx', cfg(['CLIENT*'])).visibility, 'hidden', 'globs too');
  assert.equal(resolveVisibility('/w/clientxy', cfg(['clientx'])).visibility, 'public', 'plain pattern is still an exact match');
});

test('projectNameIsPrivate: plain and glob patterns ignore case', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-vis-'));
  process.env.CLAUDE_RPC_PRIVATE_LIST = join(dir, 'private-list.json'); // empty store, not the real one
  try {
    const mod = await import('../src/privacy.js?case=' + Date.now());
    const cfg = (patterns) => ({ privacy: { patterns } });
    assert.equal(mod.projectNameIsPrivate('ClientX', cfg(['ClientX'])), true, 'same-case plain pattern');
    assert.equal(mod.projectNameIsPrivate('ClientX', cfg(['clientx'])), true);
    assert.equal(mod.projectNameIsPrivate('clientx', cfg(['CLIENTX'])), true);
    assert.equal(mod.projectNameIsPrivate('Client-Acme', cfg(['client-*'])), true);
    assert.equal(mod.projectNameIsPrivate('other', cfg(['ClientX'])), false);
  } finally {
    delete process.env.CLAUDE_RPC_PRIVATE_LIST;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── `claude-rpc private` / `public` vs the dashboard's visibility map ───
// The map outranks the legacy paths list, so both commands used to be silent
// no-ops for any cwd the Electron dashboard had an entry for.

test('addPrivateCwd hides a cwd the dashboard map marked public (or name-only, or via a parent)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-vis-'));
  process.env.CLAUDE_RPC_PRIVATE_LIST = join(dir, 'private-list.json');
  try {
    const mod = await import('../src/privacy.js?priv=' + Date.now());
    const noGh = { privacy: { autoDetectGithubPrivate: false } };
    const proj = join(dir, 'work', 'proj');
    mod.setCwdVisibility(proj, 'public');
    mod.addPrivateCwd(proj);
    assert.equal(mod.resolveVisibility(proj, noGh).visibility, 'hidden');
    assert.ok(mod.listPrivateCwds().includes(proj), 'still recorded in the private list');

    const other = join(dir, 'work', 'other');
    mod.setCwdVisibility(other, 'name-only');
    mod.addPrivateCwd(other);
    assert.equal(mod.resolveVisibility(other, noGh).visibility, 'hidden');

    const parent = join(dir, 'mono');
    mod.setCwdVisibility(parent, 'public');
    mod.addPrivateCwd(join(parent, 'pkg'));
    assert.equal(mod.resolveVisibility(join(parent, 'pkg'), noGh).visibility, 'hidden', 'parent public entry no longer wins');
    assert.equal(mod.resolveVisibility(parent, noGh).visibility, 'public', 'parent itself untouched');

    // No map entry → the map is left alone (legacy list only).
    const plain = join(dir, 'plain');
    mod.addPrivateCwd(plain);
    assert.equal(plain in mod.listVisibility(), false);
    assert.equal(mod.resolveVisibility(plain, noGh).visibility, 'hidden');
  } finally {
    delete process.env.CLAUDE_RPC_PRIVATE_LIST;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removePrivateCwd un-hides a cwd the dashboard map marked hidden (or via a parent)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-vis-'));
  process.env.CLAUDE_RPC_PRIVATE_LIST = join(dir, 'private-list.json');
  try {
    const mod = await import('../src/privacy.js?pub=' + Date.now());
    const noGh = { privacy: { autoDetectGithubPrivate: false } };
    const proj = join(dir, 'work', 'proj');
    mod.setCwdVisibility(proj, 'hidden');
    mod.removePrivateCwd(proj);
    assert.equal(mod.resolveVisibility(proj, noGh).visibility, 'public');
    assert.equal(proj in mod.listVisibility(), false, 'hiding entry cleared, not flipped');

    const parent = join(dir, 'secret');
    mod.setCwdVisibility(parent, 'hidden');
    mod.removePrivateCwd(join(parent, 'oss'));
    assert.equal(mod.resolveVisibility(join(parent, 'oss'), noGh).visibility, 'public', 'parent hidden entry no longer wins');
    assert.equal(mod.resolveVisibility(parent, noGh).visibility, 'hidden', 'parent itself untouched');

    // An explicit public entry survives (it also opts out of pattern hiding).
    const pinned = join(dir, 'client-a');
    mod.setCwdVisibility(pinned, 'public');
    mod.removePrivateCwd(pinned);
    const cfg = { privacy: { patterns: ['client-*'], autoDetectGithubPrivate: false } };
    assert.equal(mod.resolveVisibility(pinned, cfg).visibility, 'public');
  } finally {
    delete process.env.CLAUDE_RPC_PRIVATE_LIST;
    rmSync(dir, { recursive: true, force: true });
  }
});
