// vscode-extension/status-core.js — the pure view logic behind the VS Code
// status bar item. CommonJS module (the extension host's format) imported
// from ESM tests; Node bridges the two.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { pickActiveSession as daemonPick } from '../src/presence.js';

const {
  resolveStatus, buildView, humanModel, projectName,
  STATE_FILE_RE, hasStateFiles, listSessionStates, pickActiveSession, readActiveState,
} = await import('../vscode-extension/status-core.js');

const NOW = 1_750_000_000_000;

function liveState(overrides = {}) {
  return {
    status: 'working',
    lastActivity: NOW - 5_000,
    sessionStart: NOW - 20 * 60_000,
    cwd: '/home/u/projects/my-app',
    model: 'claude-fable-5',
    messages: 4,
    tools: 17,
    tokens: { input: 1000, output: 500, cacheRead: 8000, cacheWrite: 200 },
    claudeClosed: false,
    ...overrides,
  };
}

test('resolveStatus: live working state passes through', () => {
  assert.equal(resolveStatus(liveState(), { now: NOW }), 'working');
});

test('resolveStatus: claudeClosed and old activity both read as stale', () => {
  assert.equal(resolveStatus(liveState({ claudeClosed: true }), { now: NOW }), 'stale');
  assert.equal(resolveStatus(liveState({ lastActivity: NOW - 6 * 60_000 }), { now: NOW }), 'stale');
  assert.equal(resolveStatus(null, { now: NOW }), 'stale');
});

test('resolveStatus: working decays to idle past the idle threshold', () => {
  assert.equal(resolveStatus(liveState({ lastActivity: NOW - 90_000 }), { now: NOW }), 'idle');
});

test('resolveStatus: notification holds ~8s then decays', () => {
  const s = liveState({ status: 'notification', lastNotification: NOW - 3_000 });
  assert.equal(resolveStatus(s, { now: NOW }), 'notification');
  s.lastNotification = NOW - 20_000;
  assert.equal(resolveStatus(s, { now: NOW }), 'idle');
});

test('resolveStatus: shipped overlay wins for a minute', () => {
  const s = liveState({ justShipped: NOW - 10_000, justShippedKind: 'push' });
  assert.equal(resolveStatus(s, { now: NOW }), 'shipped');
  s.justShipped = NOW - 120_000;
  assert.equal(resolveStatus(s, { now: NOW }), 'working');
});

test('buildView: working label carries project and token count', () => {
  const v = buildView(liveState(), null, 0, { now: NOW });
  assert.equal(v.status, 'working');
  assert.match(v.label, /Working · my-app/);
  assert.match(v.label, /9\.7k tok/, 'grand total incl. cache');
  assert.equal(v.warning, false);
  assert.equal(v.hidden, false);
});

test('buildView: showTokens=false drops the token suffix', () => {
  const v = buildView(liveState(), null, 0, { now: NOW, showTokens: false });
  assert.ok(!/tok/.test(v.label));
});

test('buildView: notification sets the warning flag', () => {
  const v = buildView(liveState({ status: 'notification', lastNotification: NOW - 1000 }), null, 0, { now: NOW });
  assert.equal(v.warning, true);
  assert.match(v.label, /Needs you/);
});

test('buildView: pause overlays icon + label and suppresses the warning', () => {
  const v = buildView(liveState({ status: 'notification', lastNotification: NOW - 1000 }), null, NOW + 30 * 60_000, { now: NOW });
  assert.equal(v.icon, 'debug-pause');
  assert.match(v.label, /^Paused \(Discord\)/);
  assert.equal(v.warning, false);
  assert.ok(v.tooltipLines.some((l) => /paused until/.test(l)));
});

test('buildView: stale hides only when hideWhenStale is set', () => {
  const s = liveState({ claudeClosed: true });
  assert.equal(buildView(s, null, 0, { now: NOW }).hidden, false);
  assert.equal(buildView(s, null, 0, { now: NOW, hideWhenStale: true }).hidden, true);
});

test('buildView: tooltip folds in today + all-time aggregate stats', () => {
  const d = new Date(NOW);
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const agg = {
    activeMs: 100 * 3_600_000,
    sessions: 99,
    streak: 12,
    byDay: { [key]: { activeMs: 2 * 3_600_000, userMessages: 30, inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  };
  const v = buildView(liveState(), agg, 0, { now: NOW });
  assert.ok(v.tooltipLines.some((l) => /Today.*2\.0h.*30 prompts/.test(l)));
  assert.ok(v.tooltipLines.some((l) => /All-time.*100h.*99 sessions.*12-day/.test(l)));
});

test('humanModel mirror matches src/format.js for the cases that matter', () => {
  assert.equal(humanModel('claude-fable-5'), 'Fable 5');
  assert.equal(humanModel('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(humanModel('claude-sonnet-4-6-20250514'), 'Sonnet 4.6');
  assert.equal(humanModel(null), 'Claude');
});

test('projectName: basename of either path flavor', () => {
  assert.equal(projectName('/home/u/projects/my-app'), 'my-app');
  assert.equal(projectName('C:\\Users\\u\\code\\my-app'), 'my-app');
  assert.equal(projectName(''), '');
});

test('buildView: setupNeeded renders the onboarding prompt regardless of state', () => {
  const v = buildView(null, null, 0, { now: NOW, setupNeeded: true });
  assert.equal(v.status, 'setup');
  assert.equal(v.icon, 'rocket');
  assert.match(v.label, /Set up claude-rpc/);
  assert.equal(v.warning, false);
  assert.ok(v.tooltipLines.some((l) => /npx claude-rpc@latest setup/.test(l)));
  // hideWhenStale also hides the setup prompt (the "leave me alone" setting).
  assert.equal(buildView(null, null, 0, { now: NOW, setupNeeded: true, hideWhenStale: true }).hidden, true);
});

// ── Session state files ────────────────────────────────────────────────────
// Hooks write one state-<sid>.json per session; the extension used to read
// only the legacy state.json, so a real session showed "Away".

function stateDir(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'vscode-state-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

test('pickActiveSession mirrors src/presence.js exactly', () => {
  const s = (id, ago, extra = {}) => ({ sessionId: id, lastActivity: NOW - ago, ...extra });
  const cases = [
    [[], null],
    [[s('a', 5_000), s('b', 1_000)], null],
    [[s('a', 5_000), s('b', 1_000)], 'a'],
    [[s('a', 90_000), s('b', 1_000)], 'a'],
    [[s('a', 1_000, { claudeClosed: true }), s('b', 30_000)], 'a'],
    [[s('a', 1_000, { claudeClosed: true }), s('b', 300_000)], null],
    [[s('a', 400_000, { claudeClosed: true }), s('b', 300_000, { claudeClosed: true })], 'b'],
    [[{ lastActivity: NOW }, s('b', 2_000)], null],
  ];
  for (const [states, displayed] of cases) {
    assert.deepEqual(pickActiveSession(states, displayed, NOW, 60_000), daemonPick(states, displayed, NOW, 60_000));
  }
});

test('STATE_FILE_RE: the state family, not tmp/lock siblings', () => {
  assert.ok(STATE_FILE_RE.test('state.json') && STATE_FILE_RE.test('state-abc.json'));
  assert.ok(!STATE_FILE_RE.test('state-abc.json.123.tmp') && !STATE_FILE_RE.test('state-abc.json.lock'));
  assert.ok(!STATE_FILE_RE.test('pause.json'));
});

test('listSessionStates tags per-session files with their id and skips the rest', (t) => {
  const dir = stateDir(t, {
    'state-a1.json': { status: 'working' },
    'state-b2.json': '{"status": "idl', // torn mid-write
    'state.json': { status: 'idle' },
    'state-c3.json.99.tmp': { status: 'working' },
    'pause.json': { until: 1 },
  });
  assert.deepEqual(listSessionStates(dir), [{ status: 'working', sessionId: 'a1' }]);
  assert.deepEqual(listSessionStates(join(dir, 'missing')), []);
});

test('readActiveState: a real per-session state renders as working, not Away', (t) => {
  const dir = stateDir(t, {
    'state-s1.json': liveState({ lastActivity: NOW - 30_000, cwd: '/w/old-proj' }),
    'state-s2.json': liveState({ lastActivity: NOW - 2_000 }),
  });
  const { state, sessionId } = readActiveState(dir, { now: NOW });
  assert.equal(sessionId, 's2', 'most recently active session');
  const v = buildView(state, null, 0, { now: NOW });
  assert.equal(v.status, 'working');
  assert.match(v.label, /^Working · my-app/);
  // Stickiness: the displayed session holds while it's still live.
  assert.equal(readActiveState(dir, { now: NOW, displayedId: 's1' }).sessionId, 's1');
});

test('readActiveState falls back to the legacy state.json, then to nothing', (t) => {
  const legacy = stateDir(t, { 'state.json': liveState({ status: 'thinking' }) });
  const r = readActiveState(legacy, { now: NOW });
  assert.equal(r.sessionId, null);
  assert.equal(resolveStatus(r.state, { now: NOW }), 'thinking');
  const empty = stateDir(t, {});
  assert.deepEqual(readActiveState(empty, { now: NOW }), { state: null, sessionId: null });
  assert.equal(buildView(null, null, 0, { now: NOW }).label, 'Away');
});

test('hasStateFiles: any state file counts (setup detection)', (t) => {
  assert.equal(hasStateFiles(stateDir(t, { 'state-x.json': {} })), true);
  assert.equal(hasStateFiles(stateDir(t, { 'state.json': {} })), true);
  assert.equal(hasStateFiles(stateDir(t, { 'pause.json': {} })), false);
  assert.equal(hasStateFiles('/nonexistent-dir-abc123'), false);
});
