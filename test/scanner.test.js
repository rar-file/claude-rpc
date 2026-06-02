// Scanner — parseTranscript, readSessionTokens, cleanProjectName.
// The transcript parser is the source of truth for every lifetime stat;
// readSessionTokens is the only source of live token data (v0.3.11 fix).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  parseTranscript, readSessionTokens, cleanProjectName,
  discoverAltProjectDirs,
} = await import('../src/scanner.js');

function makeTranscript(records) {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-scan-'));
  const path = join(dir, 'sample.jsonl');
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n'));
  return { dir, path };
}

// ── parseTranscript ───────────────────────────────────────────────────

test('parseTranscript: counts tokens across assistant turns', () => {
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z',
      message: { content: 'hi' } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:30Z',
      message: { model: 'claude-opus-4-7',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 },
        content: [{ type: 'text', text: 'hello' }] } },
    { type: 'assistant', timestamp: '2026-05-22T10:01:00Z',
      message: { model: 'claude-opus-4-7',
        usage: { input_tokens: 200, output_tokens: 150 },
        content: [{ type: 'text', text: 'still here' }] } },
  ]);
  const s = parseTranscript(path);
  assert.equal(s.inputTokens, 300);
  assert.equal(s.outputTokens, 200);
  assert.equal(s.cacheReadTokens, 20);
  assert.equal(s.cacheWriteTokens, 5);
  assert.equal(s.project, 'proj');
  assert.equal(s.model, 'claude-opus-4-7');
  rmSync(dir, { recursive: true });
});

test('parseTranscript: counts tool calls and lines added', () => {
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z',
      message: { content: 'go' } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:30Z',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 0, output_tokens: 0 },
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/x.js', old_string: 'a\nb', new_string: 'a\nb\nc\nd' } },
          { type: 'tool_use', name: 'Write', input: { file_path: '/y.js', content: 'one\ntwo\nthree' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
        ] } },
  ]);
  const s = parseTranscript(path);
  assert.equal(s.toolCalls, 3);
  assert.equal(s.linesAdded, 4 + 3, 'Edit adds 4 + Write adds 3');
  assert.equal(s.linesRemoved, 2, 'Edit removes 2');
  assert.equal(s.bashCommands.git, 1);
  rmSync(dir, { recursive: true });
});

test('parseTranscript: skips meta and system-reminder user messages', () => {
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj',
      message: { content: 'real prompt' } },
    { type: 'user', sessionId: 's1', isMeta: true,
      message: { content: 'meta prompt — should be skipped' } },
    { type: 'user', sessionId: 's1',
      message: { content: '<system-reminder>blah</system-reminder>' } },
    { type: 'user', sessionId: 's1',
      message: { content: '<local-command-stdout>blah</local-command-stdout>' } },
  ]);
  const s = parseTranscript(path);
  assert.equal(s.userMessages, 1, 'only the real prompt counts');
  rmSync(dir, { recursive: true });
});

// ── readSessionTokens ────────────────────────────────────────────────

test('readSessionTokens: returns null for missing file', () => {
  assert.equal(readSessionTokens('/no/such/file.jsonl'), null);
});

test('readSessionTokens: sums tokens across assistant records', () => {
  const { dir, path } = makeTranscript([
    { type: 'user',      message: { content: 'hi' } },
    { type: 'assistant', message: { model: 'claude-opus-4-7',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 } } },
    { type: 'assistant', message: { model: 'claude-opus-4-7',
        usage: { input_tokens: 250, output_tokens: 200, cache_read_input_tokens: 80 } } },
  ]);
  const t = readSessionTokens(path);
  assert.equal(t.input, 350);
  assert.equal(t.output, 250);
  assert.equal(t.cacheRead, 100);
  assert.equal(t.cacheWrite, 5);
  rmSync(dir, { recursive: true });
});

test('readSessionTokens: mtime-cached (same call returns same ref)', () => {
  const { dir, path } = makeTranscript([
    { type: 'assistant', message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } } },
  ]);
  const t1 = readSessionTokens(path);
  const t2 = readSessionTokens(path);
  assert.equal(t1, t2, 'second call returns the cached object');
  rmSync(dir, { recursive: true });
});

// ── cleanProjectName ──────────────────────────────────────────────────

test('cleanProjectName strips ISO-ish date suffix', () => {
  assert.equal(cleanProjectName('archive-2026-04-25T185311Z'), 'archive');
  assert.equal(cleanProjectName('backup_2026.04.25'), 'backup');
  assert.equal(cleanProjectName('myproj'), 'myproj');
});

// ── discoverAltProjectDirs ────────────────────────────────────────────

test('discoverAltProjectDirs returns an array', () => {
  const dirs = discoverAltProjectDirs();
  assert.ok(Array.isArray(dirs), 'returns an array');
  // Cannot assert contents — depends on test machine.
});

// ── dayKey / weekKey / hourKey ─────────────────────────────────────────

const { dayKey, weekKey, hourKey } = await import('../src/scanner.js');

test('dayKey: YYYY-MM-DD local time', () => {
  const ts = new Date(2026, 4, 23, 10, 0, 0).getTime(); // 2026-05-23 local
  assert.equal(dayKey(ts), '2026-05-23');
});

test('weekKey: ISO week, Monday-anchored', () => {
  // 2026-05-23 is a Saturday, ISO week 21 of 2026.
  const ts = new Date(2026, 4, 23).getTime();
  assert.match(weekKey(ts), /^2026-W\d{2}$/);
});

test('hourKey: 0..23 from local time', () => {
  const ts = new Date(2026, 4, 23, 14, 30).getTime();
  assert.equal(hourKey(ts), 14);
});

// ── v0.9: model split + hotspot aging (parse-level) ─────────────────────

test('parseTranscript: byModel accumulates turns/tokens/cost per model', () => {
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z', message: { content: 'go' } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:30Z',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: 'a' }] } },
    { type: 'assistant', timestamp: '2026-05-22T10:01:00Z',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 200, output_tokens: 100 }, content: [{ type: 'text', text: 'b' }] } },
  ]);
  const s = parseTranscript(path);
  const keys = Object.keys(s.byModel);
  assert.equal(keys.length, 1, 'one model bucket');
  const mb = s.byModel[keys[0]];
  assert.equal(mb.turns, 2);
  assert.equal(mb.tokens, 450, 'sum of in+out across both turns');
  assert.ok(mb.cost > 0, 'cost accrued');
  rmSync(dir, { recursive: true });
});

test('parseTranscript: fileEditTs records most-recent edit timestamp', () => {
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z', message: { content: 'go' } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:30Z',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x.js', old_string: 'a', new_string: 'b' } }] } },
    { type: 'assistant', timestamp: '2026-05-23T12:00:00Z',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x.js', old_string: 'b', new_string: 'c' } }] } },
  ]);
  const s = parseTranscript(path);
  assert.equal(s.fileEdits['/x.js'], 2);
  assert.equal(s.fileEditTs['/x.js'], new Date('2026-05-23T12:00:00Z').getTime(), 'keeps the latest edit ts');
  rmSync(dir, { recursive: true });
});
