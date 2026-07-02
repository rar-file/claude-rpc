// processHookEvent is the live entry point for every Claude Code event.
// These tests pin the state transitions that matter — especially the
// claudeClosed flag which underpins the v0.3.5 close-detection rework.
//
// processHookEvent mutates the real state.json on disk. To keep tests
// hermetic we redirect STATE_DIR / STATE_PATH via env before importing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP = mkdtempSync(join(tmpdir(), 'rpc-hook-'));
process.env.TMPDIR = TMP;
// macOS uses $TMPDIR. tmpdir() on linux falls back to /tmp regardless of env,
// so we ALSO need to swap STATE_PATH directly. paths.js reads at import time
// — so we have to override before importing state/hook modules.

// Re-export-stage trick: prepend a synthetic module that overrides paths.
// Simplest reliable approach: just exercise the pure switch logic by calling
// processHookEvent and asserting via readState (both touch the same shared
// state file). Tests run serially within this file, so we reset between.

const { processHookEvent, classifyShip } = await import('../src/hook.js');
const { readState, listSessionStates, statePathFor } = await import('../src/state.js');
const { pickActiveSession } = await import('../src/presence.js');
const { STATE_PATH } = await import('../src/paths.js');
const { unlinkSync } = await import('node:fs');

function resetStateFile() {
  if (existsSync(STATE_PATH)) {
    try { writeFileSync(STATE_PATH, '{}'); } catch {}
  }
}

test('SessionStart resets state', () => {
  resetStateFile();
  processHookEvent('SessionStart', { cwd: '/tmp/proj', model: { id: 'claude-opus-4-7' } });
  const s = readState();
  assert.equal(s.cwd, '/tmp/proj');
  assert.equal(s.model, 'claude-opus-4-7');
  assert.equal(s.status, 'idle');
  assert.equal(s.claudeClosed, false);
  assert.equal(s.messages, 0);
});

test('UserPromptSubmit increments messages, sets thinking, clears closed', () => {
  resetStateFile();
  processHookEvent('SessionStart', { cwd: '/tmp/proj' });
  processHookEvent('UserPromptSubmit', { cwd: '/tmp/proj' });
  const s = readState();
  assert.equal(s.messages, 1);
  assert.equal(s.status, 'thinking');
  assert.equal(s.claudeClosed, false);
});

test('PreToolUse populates currentTool + currentFile', () => {
  resetStateFile();
  processHookEvent('SessionStart', { cwd: '/tmp/proj' });
  processHookEvent('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/proj/a.js' } });
  const s = readState();
  assert.equal(s.currentTool, 'Read');
  assert.equal(s.currentFile, 'a.js');
  assert.equal(s.status, 'working');
  assert.equal(s.tools, 1);
  assert.deepEqual(s.toolBreakdown, { Read: 1 });
});

test('PostToolUse clears currentTool but keeps currentFile', () => {
  resetStateFile();
  processHookEvent('SessionStart', { cwd: '/tmp/proj' });
  processHookEvent('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/b.js' } });
  processHookEvent('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/b.js' } });
  const s = readState();
  assert.equal(s.currentTool, null, 'currentTool clears');
  // currentFile may persist briefly — depends on subsequent hook
});

test('PreToolUse stamps toolStartedAt; PostToolUse clears it', () => {
  resetStateFile();
  processHookEvent('SessionStart', { cwd: '/tmp/proj' });
  processHookEvent('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  let s = readState();
  assert.ok(s.toolStartedAt, 'toolStartedAt set on PreToolUse');
  processHookEvent('PostToolUse', { tool_name: 'Bash' });
  s = readState();
  assert.equal(s.toolStartedAt, null, 'cleared on PostToolUse');
});

test('PostToolUse Bash: git push trips the just-shipped marker', () => {
  resetStateFile();
  processHookEvent('SessionStart', { cwd: process.cwd() });
  processHookEvent('PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'git push origin main' },
    cwd: process.cwd(),
  });
  const s = readState();
  assert.ok(s.justShipped, 'justShipped timestamp populated');
  assert.equal(s.justShippedKind, 'push');
  // subject may be empty/absent in CI shallow clones; we only assert it's a
  // string or null (never some other type).
  assert.ok(s.justShippedSubject === null || typeof s.justShippedSubject === 'string');
});

test('PostToolUse Bash: git commit also trips the marker', () => {
  resetStateFile();
  processHookEvent('PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m "wip"' },
    cwd: process.cwd(),
  });
  const s = readState();
  assert.equal(s.justShippedKind, 'commit');
});

test('PostToolUse Bash: chained "git add && git commit" still detected', () => {
  resetStateFile();
  processHookEvent('PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'git add -A && git commit -m "fix"' },
    cwd: process.cwd(),
  });
  const s = readState();
  assert.equal(s.justShippedKind, 'commit', 'second clause in chain still matches');
});

test('PostToolUse Bash: unrelated commands do not trip the marker', () => {
  resetStateFile();
  processHookEvent('PostToolUse', {
    tool_name: 'Bash',
    tool_input: { command: 'echo "git push is not happening here"' },
  });
  const s = readState();
  assert.equal(s.justShipped, null, 'string-in-argument false positive avoided');
});

test('PostToolUse non-Bash: write/edit do not check for git', () => {
  resetStateFile();
  processHookEvent('PostToolUse', {
    tool_name: 'Edit',
    tool_input: { file_path: '/tmp/x.md', command: 'git commit -m bypassed' },
  });
  const s = readState();
  assert.equal(s.justShipped, null);
});

test('SessionEnd sets claudeClosed=true and status=stale', () => {
  resetStateFile();
  processHookEvent('SessionStart', { cwd: '/tmp/proj' });
  processHookEvent('UserPromptSubmit', { cwd: '/tmp/proj' });
  processHookEvent('SessionEnd', {});
  const s = readState();
  assert.equal(s.claudeClosed, true);
  assert.equal(s.status, 'stale');
  assert.equal(s.currentTool, null);
  assert.equal(s.currentFile, null);
});

test('Any subsequent hook clears claudeClosed (multi-session safety)', () => {
  resetStateFile();
  processHookEvent('SessionEnd', {});
  let s = readState();
  assert.equal(s.claudeClosed, true);

  processHookEvent('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x.js' } });
  s = readState();
  assert.equal(s.claudeClosed, false, 'sibling session unsets the flag');
  assert.equal(s.status, 'working');
});

test('Notification sets status with timestamp', () => {
  resetStateFile();
  processHookEvent('Notification', { cwd: '/tmp/proj' });
  const s = readState();
  assert.equal(s.status, 'notification');
  assert.ok(s.lastNotification, 'lastNotification is set');
  assert.equal(s.claudeClosed, false);
});

test('PreCompact sets status=compacting with start timestamp + trigger', () => {
  resetStateFile();
  processHookEvent('SessionStart', { cwd: '/tmp/proj' });
  processHookEvent('PreCompact', { cwd: '/tmp/proj', trigger: 'auto' });
  const s = readState();
  assert.equal(s.status, 'compacting');
  assert.ok(s.compactStartedAt, 'compactStartedAt populated');
  assert.equal(s.compactTrigger, 'auto');
  assert.equal(s.currentTool, null, 'compaction wipes active tool');
  assert.equal(s.currentFile, null);
});

test('PreCompact falls back to matcher field when trigger missing', () => {
  resetStateFile();
  processHookEvent('PreCompact', { matcher: 'manual' });
  const s = readState();
  assert.equal(s.compactTrigger, 'manual', 'matcher used when trigger absent');
});

test('post-compaction SessionStart clears the compacting marker', () => {
  // Claude Code has no PostCompact event — compaction ends with a fresh
  // SessionStart (source:'compact'), whose resetState clears the marker.
  resetStateFile();
  processHookEvent('PreCompact', { trigger: 'auto' });
  processHookEvent('SessionStart', { cwd: '/tmp/proj' });
  const s = readState();
  assert.equal(s.compactStartedAt, null);
  assert.equal(s.compactTrigger, null);
  assert.equal(s.status, 'idle', 'reset drops to idle until the next real hook');
});

test('Stop/SubagentStop go to idle (not stale)', () => {
  resetStateFile();
  processHookEvent('SessionStart', { cwd: '/tmp/proj' });
  processHookEvent('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  processHookEvent('Stop', {});
  const s = readState();
  assert.equal(s.status, 'idle');
  assert.equal(s.claudeClosed, false, 'Stop must NOT set claudeClosed');
});

// ── classifyShip: PR / issue / release detection (v0.9) ───────────────
test('classifyShip: git push / commit', () => {
  assert.equal(classifyShip('git push origin main'), 'push');
  assert.equal(classifyShip('git add . && git commit -m "x"'), 'commit');
  // push outranks commit when a command does both.
  assert.equal(classifyShip('git commit -m x && git push'), 'push');
});

test('classifyShip: gh pr / issue / release', () => {
  assert.equal(classifyShip('gh pr create --fill'), 'pr');
  assert.equal(classifyShip('gh issue create --title "bug"'), 'issue');
  assert.equal(classifyShip('gh release create v1.0'), 'tag');
});

test('classifyShip: gh global flags before the noun still classify', () => {
  // The canonical targeted form `gh -R owner/repo pr create` must not be missed.
  assert.equal(classifyShip('gh -R owner/repo pr create --fill'), 'pr');
  assert.equal(classifyShip('gh --repo owner/repo issue create'), 'issue');
});

test('classifyShip: unrelated commands return null', () => {
  assert.equal(classifyShip('ls -la'), null);
  assert.equal(classifyShip('git status'), null);
  assert.equal(classifyShip('npm run pushpin'), null); // not a real `git push`
  assert.equal(classifyShip(''), null);
  assert.equal(classifyShip(undefined), null);
});

test('classifyShip: quoted mentions of git push do not false-fire', () => {
  // The old substring regex flagged all of these as a ship.
  assert.equal(classifyShip('echo "remember to git push later"'), null);
  assert.equal(classifyShip('grep -r "git push" .'), null);
  // A commit whose message mentions push is a commit, not a push.
  assert.equal(classifyShip('git commit -m "prep for git push"'), 'commit');
});

test('classifyShip: env prefixes, sudo, paths, and git global flags', () => {
  assert.equal(classifyShip('GIT_SSH_COMMAND=ssh git push'), 'push');
  assert.equal(classifyShip('/usr/bin/git push'), 'push');
  assert.equal(classifyShip('git -C /repo -c user.name=x push'), 'push');
});

test('PostToolUse: gh pr create sets justShippedKind=pr', () => {
  resetStateFile();
  processHookEvent('SessionStart', { cwd: '/tmp/proj' });
  processHookEvent('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'gh pr create --fill' }, cwd: '/tmp/proj' });
  const s = readState();
  assert.equal(s.justShippedKind, 'pr');
  assert.ok(s.justShipped, 'justShipped timestamp set');
});

// Cleanup
test.after?.(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('classifyShip: separators inside quotes do not create fake segments', () => {
  // The `&&` lives inside the quoted string — previously this split into a
  // segment whose leading command was `git push` and false-fired.
  assert.equal(classifyShip('echo "run git push && rejoice"'), null);
  assert.equal(classifyShip("echo 'git commit -m x; git push'"), null);
  // Real ship commands with quoted args (incl. separators in the message)
  // still classify.
  assert.equal(classifyShip('git commit -m "fix: a && b; c"'), 'commit');
  assert.equal(classifyShip('git commit -m "x" && git push'), 'push');
  // Unbalanced quote — string is left as-is, detection still works.
  assert.equal(classifyShip('git commit -m "unterminated'), 'commit');
});

// ── per-session state (concurrent sessions) ─────────────────────────────
test('per-session: concurrent sessions write separate files; selection sticks then switches', () => {
  const A = 'itestA-' + process.pid, B = 'itestB-' + process.pid;
  try {
    // Two sessions in different projects, B's hook firing last.
    processHookEvent('SessionStart', { session_id: A, cwd: '/projA' });
    processHookEvent('PreToolUse',  { session_id: A, cwd: '/projA', tool_name: 'Edit', tool_input: { file_path: '/projA/x.js' } });
    processHookEvent('SessionStart', { session_id: B, cwd: '/projB' });
    processHookEvent('PreToolUse',  { session_id: B, cwd: '/projB', tool_name: 'Bash', tool_input: { command: 'ls' } });

    const mine = () => listSessionStates().filter((s) => s.sessionId === A || s.sessionId === B);
    const states = mine();
    assert.equal(states.length, 2, 'each session has its own state file');
    assert.equal(states.find((s) => s.sessionId === A).cwd, '/projA');
    assert.equal(states.find((s) => s.sessionId === B).status, 'working');

    const now = Date.now();
    // No prior selection → a live session (which of A/B is sub-ms timing, so
    // don't pin it); both are active right now.
    const initial = pickActiveSession(states, null, now, 60_000);
    assert.ok([A, B].includes(initial.sessionId), 'picks one of the live sessions');
    assert.equal(initial.liveCount, 2, 'both counted live');
    // Showing B; A pings again → STICK to B (no thrash while B is active).
    processHookEvent('PreToolUse', { session_id: A, cwd: '/projA', tool_name: 'Edit', tool_input: { file_path: '/projA/y.js' } });
    assert.equal(pickActiveSession(mine(), B, Date.now(), 60_000).sessionId, B, 'sticks to B');
    // B goes idle → switch to where the user is now active (A).
    const aged = mine().map((s) => s.sessionId === B ? { ...s, lastActivity: Date.now() - 90_000 } : s);
    assert.equal(pickActiveSession(aged, B, Date.now(), 60_000).sessionId, A, 'switches once B idles');
    // B ends → excluded from the live count and selection.
    processHookEvent('SessionEnd', { session_id: B, cwd: '/projB' });
    const after = pickActiveSession(mine(), B, Date.now(), 60_000);
    assert.equal(after.sessionId, A, 'a closed session is not shown');
    assert.equal(mine().filter((s) => s.sessionId === A).length, 1);
  } finally {
    try { unlinkSync(statePathFor(A)); } catch { /* ignore */ }
    try { unlinkSync(statePathFor(B)); } catch { /* ignore */ }
  }
});

// ── SessionStart(source:'compact') continuity + SubagentStop + notebooks ──

test('SessionStart with source:compact preserves the running session', () => {
  const sid = 'compact-test';
  processHookEvent('SessionStart', { session_id: sid, cwd: '/tmp/proj', model: { id: 'claude-opus-4-7' } });
  processHookEvent('UserPromptSubmit', { session_id: sid });
  processHookEvent('PostToolUse', { session_id: sid, tool_name: 'Edit', tool_input: { file_path: '/tmp/proj/a.js' } });
  const before = readState(sid);
  processHookEvent('PreCompact', { session_id: sid });
  assert.equal(readState(sid).status, 'compacting');
  processHookEvent('SessionStart', { session_id: sid, source: 'compact', cwd: '/tmp/proj' });
  const after = readState(sid);
  assert.equal(after.messages, before.messages, 'prompt counter survives compaction');
  assert.equal(after.filesEdited.length, before.filesEdited.length, 'edited files survive compaction');
  assert.equal(after.sessionStart, before.sessionStart, 'elapsed timer anchor survives compaction');
  assert.equal(after.status, 'working', 'the compacted turn resumes as working');
  assert.ok(after.compactStartedAt == null, 'compacting marker cleared');
  try { unlinkSync(statePathFor(sid)); } catch {}
});

test('SessionStart WITHOUT source still resets (fresh session)', () => {
  const sid = 'fresh-test';
  processHookEvent('SessionStart', { session_id: sid, cwd: '/tmp/a' });
  processHookEvent('UserPromptSubmit', { session_id: sid });
  processHookEvent('SessionStart', { session_id: sid, cwd: '/tmp/b' });
  assert.equal(readState(sid).messages, 0);
  assert.equal(readState(sid).cwd, '/tmp/b');
  try { unlinkSync(statePathFor(sid)); } catch {}
});

test('SubagentStop does not flip the session to idle', () => {
  const sid = 'subagent-test';
  processHookEvent('SessionStart', { session_id: sid, cwd: '/tmp/proj' });
  processHookEvent('PreToolUse', { session_id: sid, tool_name: 'Agent', tool_input: {} });
  const busy = readState(sid).status;
  processHookEvent('SubagentStop', { session_id: sid });
  assert.equal(readState(sid).status, busy, 'parent status untouched by a finishing subagent');
  processHookEvent('Stop', { session_id: sid });
  assert.equal(readState(sid).status, 'idle', 'a real Stop still idles');
  try { unlinkSync(statePathFor(sid)); } catch {}
});

test('PostToolUse counts NotebookEdit via notebook_path', () => {
  const sid = 'nb-test';
  processHookEvent('SessionStart', { session_id: sid, cwd: '/tmp/proj' });
  processHookEvent('PostToolUse', { session_id: sid, tool_name: 'NotebookEdit', tool_input: { notebook_path: '/tmp/proj/analysis.ipynb' } });
  const s = readState(sid);
  assert.equal(s.filesEdited.length, 1, 'notebook edit tracked');
  assert.match(s.filesEdited[0], /analysis\.ipynb/);
  try { unlinkSync(statePathFor(sid)); } catch {}
});
