// Scanner — parseTranscript, readSessionTokens, cleanProjectName.
// The transcript parser is the source of truth for every lifetime stat;
// readSessionTokens is the only source of live token data (v0.3.11 fix).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdtempSync, mkdirSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const {
  parseTranscript, readSessionTokens, readSessionModel, cleanProjectName,
  discoverAltProjectDirs, findLiveSessions, aggregateFrom,
} = await import('../src/scanner.js');
const { costFor } = await import('../src/pricing.js');

function makeTranscript(records) {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-scan-'));
  const path = join(dir, 'sample.jsonl');
  // Real Claude Code transcripts append each record as `JSON + '\n'`, so the
  // file is newline-terminated. Match that here.
  writeFileSync(path, records.map((r) => JSON.stringify(r) + '\n').join(''));
  return { dir, path };
}

test('findLiveSessions: aggregates live transcripts across multiple project roots', () => {
  const rootA = mkdtempSync(join(tmpdir(), 'rpc-rootA-'));
  const rootB = mkdtempSync(join(tmpdir(), 'rpc-rootB-'));
  mkdirSync(join(rootA, 'projA'));
  mkdirSync(join(rootB, 'projB'));
  writeFileSync(join(rootA, 'projA', 's1.jsonl'), '');
  writeFileSync(join(rootB, 'projB', 's2.jsonl'), '');
  // Explicit multi-root: both fresh sessions show up. In production the default
  // roots are CLAUDE_PROJECTS + discoverAltProjectDirs(), so relocated installs
  // no longer go silent.
  const live = findLiveSessions({ projectsDirs: [rootA, rootB], thresholdMs: 90_000 });
  assert.equal(live.length, 2);
  rmSync(rootA, { recursive: true, force: true });
  rmSync(rootB, { recursive: true, force: true });
});

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

test('parseTranscript: MultiEdit counts churn (per-edit) and one file edit', () => {
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z',
      message: { content: 'go' } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:30Z',
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 0, output_tokens: 0 },
        content: [
          { type: 'tool_use', name: 'MultiEdit', input: { file_path: '/m.js', edits: [
            { old_string: 'a', new_string: 'a\nb\nc' },   // +3, -1
            { old_string: 'x\ny', new_string: 'z' },        // +1, -2
          ] } },
        ] } },
  ]);
  const s = parseTranscript(path);
  assert.equal(s.linesAdded, 4, 'MultiEdit adds 3 + 1');
  assert.equal(s.linesRemoved, 3, 'MultiEdit removes 1 + 2');
  assert.equal(s.fileEdits['/m.js'], 1, 'MultiEdit counts as one edit of the file');
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

test('readSessionTokens: incremental append accumulates across reads', () => {
  const { dir, path } = makeTranscript([
    { type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 } } },
  ]);
  const t1 = readSessionTokens(path);
  assert.equal(t1.input, 100);
  assert.equal(t1.output, 50);
  // Append a record and bump mtime so the cache invalidates; the reader should
  // parse only the appended tail and add it to the running totals.
  appendFileSync(path, JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 250, output_tokens: 30 } } }) + '\n');
  const future = new Date(Date.now() + 5000);
  utimesSync(path, future, future);
  const t2 = readSessionTokens(path);
  assert.equal(t2.input, 350);
  assert.equal(t2.output, 80);
  assert.equal(t2.cacheRead, 10);
  rmSync(dir, { recursive: true });
});

test('readSessionTokens: counts a repeated message.id once (multi-block turns)', () => {
  // Claude Code repeats the same usage object on every content-block line of
  // one assistant message; the live count must dedup by message.id exactly
  // like the lifetime scanner does, or the card drifts above the aggregate.
  const usage = { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 };
  const { dir, path } = makeTranscript([
    { type: 'assistant', message: { id: 'msg_1', usage } },
    { type: 'assistant', message: { id: 'msg_1', usage } },
    { type: 'assistant', message: { id: 'msg_1', usage } },
    { type: 'assistant', message: { id: 'msg_2', usage } },
    { type: 'assistant', message: { usage } }, // no id (legacy) — always counts
  ]);
  const t = readSessionTokens(path);
  assert.equal(t.input, 300, 'msg_1 once + msg_2 + legacy line');
  assert.equal(t.output, 120);
  assert.equal(t.cacheRead, 30);
  rmSync(dir, { recursive: true });
});

test('readSessionTokens: id dedup survives incremental appends', () => {
  const usage = { input_tokens: 50, output_tokens: 20 };
  const { dir, path } = makeTranscript([
    { type: 'assistant', message: { id: 'msg_a', usage } },
  ]);
  assert.equal(readSessionTokens(path).input, 50);
  // The same message.id continues in the appended tail (streamed blocks of the
  // same turn) — it must not be recounted.
  appendFileSync(path, JSON.stringify({ type: 'assistant', message: { id: 'msg_a', usage } }) + '\n');
  appendFileSync(path, JSON.stringify({ type: 'assistant', message: { id: 'msg_b', usage } }) + '\n');
  const future = new Date(Date.now() + 5000);
  utimesSync(path, future, future);
  const t = readSessionTokens(path);
  assert.equal(t.input, 100, 'msg_a once across both reads + msg_b');
  rmSync(dir, { recursive: true });
});

test('readSessionTokens: a split message counts at its final usage, across appends', () => {
  // output_tokens is a running count while a message streams: a later block
  // line of the same message.id can carry more than the first did.
  const { dir, path } = makeTranscript([
    { type: 'assistant', message: { id: 'msg_s', usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 500 } } },
    { type: 'assistant', message: { id: 'msg_s', usage: { input_tokens: 10, output_tokens: 300, cache_read_input_tokens: 500 } } },
  ]);
  const t1 = readSessionTokens(path);
  assert.deepEqual([t1.input, t1.output, t1.cacheRead], [10, 300, 500]);
  // Its last block lands after the read; an older, smaller snapshot never
  // takes anything back.
  appendFileSync(path, JSON.stringify({ type: 'assistant', message: { id: 'msg_s', usage: { input_tokens: 10, output_tokens: 420, cache_read_input_tokens: 500 } } }) + '\n');
  appendFileSync(path, JSON.stringify({ type: 'assistant', message: { id: 'msg_s', usage: { input_tokens: 10, output_tokens: 8, cache_read_input_tokens: 500 } } }) + '\n');
  const future = new Date(Date.now() + 5000);
  utimesSync(path, future, future);
  const t2 = readSessionTokens(path);
  assert.deepEqual([t2.input, t2.output, t2.cacheRead], [10, 420, 500]);
  rmSync(dir, { recursive: true });
});

test('readSessionModel: reports the newest turn model, tracking /model switches', () => {
  const { dir, path } = makeTranscript([
    { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 1 } } },
  ]);
  assert.equal(readSessionModel(path), 'claude-sonnet-5');
  appendFileSync(path, JSON.stringify({ type: 'assistant', message: { id: 'm2', model: 'claude-opus-4-8', usage: { input_tokens: 1 } } }) + '\n');
  const future = new Date(Date.now() + 5000);
  utimesSync(path, future, future);
  assert.equal(readSessionModel(path), 'claude-opus-4-8', 'switch shows without a new SessionStart');
  assert.equal(readSessionModel('/no/such/file.jsonl'), null);
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

// ── v0.12: dedupe split assistant messages (token/cost overcount fix) ────
test('parseTranscript: usage counted once per message.id across split lines', () => {
  // Claude Code splits one assistant message (same message.id) across lines,
  // one per content block, repeating the SAME usage on each. Tokens must count
  // once; the distinct tool_use blocks still count per line.
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z', message: { content: 'go' } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:10Z',
      message: { id: 'msg_A', model: 'claude-opus-4-7', usage: { input_tokens: 50, output_tokens: 100 },
        content: [{ type: 'thinking', text: '...' }] } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:11Z',
      message: { id: 'msg_A', model: 'claude-opus-4-7', usage: { input_tokens: 50, output_tokens: 100 },
        content: [{ type: 'text', text: 'hi' }] } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:12Z',
      message: { id: 'msg_A', model: 'claude-opus-4-7', usage: { input_tokens: 50, output_tokens: 100 },
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  ]);
  const s = parseTranscript(path);
  assert.equal(s.outputTokens, 100, 'tokens counted once, not 3×');
  assert.equal(s.inputTokens, 50);
  assert.equal(s.toolCalls, 1, 'the single tool_use block still counts');
  // turns counted once per message id
  const mk = Object.values(s.byModel)[0];
  assert.equal(mk.turns, 1, 'one turn, not three');
  assert.equal(mk.tokens, 150, 'in+out once');
  rmSync(dir, { recursive: true });
});

test('parseTranscript: a split message counts at its final usage, not its first line', () => {
  // Real Claude Code 2.1 transcripts: the thinking block's line carries an
  // early output_tokens snapshot; the tool_use line after it carries the final
  // count. Input/cache repeat unchanged. Counting the first line only
  // under-counted output (and so cost).
  const first = { input_tokens: 6, output_tokens: 9, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 1_200 };
  const last = { ...first, output_tokens: 640 };
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z', message: { content: 'go' } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:10Z',
      message: { id: 'msg_G', model: 'claude-opus-4-7', usage: first, content: [{ type: 'thinking', text: '...' }] } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:11Z',
      message: { id: 'msg_G', model: 'claude-opus-4-7', usage: last, content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } },
  ]);
  const s = parseTranscript(path);
  assert.equal(s.outputTokens, 640, 'final output count, once');
  assert.equal(s.inputTokens, 6);
  assert.equal(s.cacheReadTokens, 40_000, 'unchanged fields once');
  assert.equal(s.cacheWriteTokens, 1_200);
  const want = costFor({ model: 'claude-opus-4-7', usage: last });
  assert.ok(Math.abs(s.cost - want) < 1e-12, 'cost of the final usage');
  const mk = Object.values(s.byModel)[0];
  assert.equal(mk.turns, 1, 'still one turn');
  assert.equal(mk.tokens, 6 + 640 + 40_000 + 1_200);
  assert.equal(Object.values(s.byDay)[0].outputTokens, 640);
  rmSync(dir, { recursive: true });
});

// ── Incremental (append-only) re-parse ───────────────────────────────────

test('parseTranscript: append-parse counts a message that grows across the boundary at its final usage', () => {
  const u = (out) => ({ input_tokens: 5, output_tokens: out, cache_read_input_tokens: 900 });
  const line = (out, ts, block) => ({ type: 'assistant', timestamp: ts,
    message: { id: 'msg_X', model: 'claude-opus-4-7', usage: u(out), content: [block] } });
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z', message: { content: 'go' } },
    line(12, '2026-05-22T10:00:10Z', { type: 'thinking', text: '...' }),
  ]);
  const prev = parseTranscript(path);
  const prevIds = JSON.stringify(prev._parse.recentIds);
  appendFileSync(path, [
    line(300, '2026-05-22T10:00:11Z', { type: 'text', text: 'hi' }),
    line(450, '2026-05-22T10:00:12Z', { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }),
  ].map((r) => JSON.stringify(r) + '\n').join(''));
  const incremental = parseTranscript(path, prev);
  const full = parseTranscript(path);
  assert.equal(incremental.outputTokens, 450);
  assert.equal(incremental.cacheReadTokens, 900);
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cost', 'byModel', 'byDay', 'costByModel', 'modelsUsed']) {
    assert.deepEqual(incremental[k], full[k], `${k} matches full re-parse`);
  }
  assert.equal(JSON.stringify(prev._parse.recentIds), prevIds, 'the cached entry it appended onto is left as it was');
  rmSync(dir, { recursive: true });
});

test('parseTranscript: append-parse from a prior entry matches a full re-parse', () => {
  const first = [
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z',
      message: { content: 'go' } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:30Z',
      message: { id: 'msg_1', model: 'claude-opus-4-7',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/x.js', old_string: 'a', new_string: 'b\nc' } }] } },
  ];
  const appended = [
    // Same message id continues across the boundary — usage must not double-count.
    { type: 'assistant', timestamp: '2026-05-22T10:00:31Z',
      message: { id: 'msg_1', model: 'claude-opus-4-7',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:02:00Z',
      message: { content: 'more' } },
    { type: 'assistant', timestamp: '2026-05-22T10:02:30Z',
      message: { id: 'msg_2', model: 'claude-opus-4-7',
        usage: { input_tokens: 40, output_tokens: 60 },
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } },
  ];
  const { dir, path } = makeTranscript(first);
  const prev = parseTranscript(path);
  assert.equal(typeof prev._offset, 'number', 'entry records its consumed-byte offset');

  appendFileSync(path, appended.map((r) => JSON.stringify(r) + '\n').join(''));
  const incremental = parseTranscript(path, prev);
  const full = parseTranscript(path); // from-scratch reference

  for (const k of ['inputTokens', 'outputTokens', 'userMessages', 'toolCalls',
                   'activeMs', 'firstTs', 'lastTs', 'linesAdded', 'linesRemoved']) {
    assert.deepEqual(incremental[k], full[k], `${k} matches full re-parse`);
  }
  assert.deepEqual(incremental.byDay, full.byDay, 'per-day buckets match');
  assert.deepEqual(incremental.byModel, full.byModel, 'model split matches (msg_1 deduped across the boundary)');
  assert.deepEqual(incremental.fileEdits, full.fileEdits);
  assert.equal(incremental.bashCommands.npm, 1);
  rmSync(dir, { recursive: true });
});

test('parseTranscript: a shrunk file falls back to a full re-parse', () => {
  const { dir, path } = makeTranscript([
    { type: 'assistant', timestamp: '2026-05-22T10:00:00Z',
      message: { model: 'm', usage: { input_tokens: 100, output_tokens: 0 }, content: [] } },
    { type: 'assistant', timestamp: '2026-05-22T10:00:10Z',
      message: { model: 'm', usage: { input_tokens: 200, output_tokens: 0 }, content: [] } },
  ]);
  const prev = parseTranscript(path);
  // Rewrite shorter (e.g. transcript replaced) — prev._offset > new size.
  writeFileSync(path, JSON.stringify(
    { type: 'assistant', timestamp: '2026-05-22T11:00:00Z',
      message: { model: 'm', usage: { input_tokens: 7, output_tokens: 0 }, content: [] } }) + '\n');
  const s = parseTranscript(path, prev);
  assert.equal(s.inputTokens, 7, 'parsed from scratch, not stacked on the stale entry');
  rmSync(dir, { recursive: true });
});

test('parseTranscript: trailing partial line is left for the next read', () => {
  const { dir, path } = makeTranscript([
    { type: 'assistant', timestamp: '2026-05-22T10:00:00Z',
      message: { model: 'm', usage: { input_tokens: 10, output_tokens: 0 }, content: [] } },
  ]);
  // Simulate a mid-write line: no trailing newline, not valid JSON.
  appendFileSync(path, '{"type":"assistant","message":{"usage":{"input_to');
  const prev = parseTranscript(path);
  assert.equal(prev.inputTokens, 10, 'partial line not counted');
  assert.equal(typeof prev._offset, 'number', 'still appendable');
  // Writer finishes the line; the append-parse picks up the whole record.
  appendFileSync(path, 'kens":5,"output_tokens":0}}}\n');
  const s = parseTranscript(path, prev);
  assert.equal(s.inputTokens, 15, 'completed line counted exactly once');
  rmSync(dir, { recursive: true });
});

test('parseTranscript: a rewritten file in the [offset, size) window is NOT appended (no stale carryover)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rpc-scan-'));
  const path = join(dir, 's.jsonl');
  const rec = (i) => JSON.stringify({ type: 'assistant', timestamp: '2026-05-22T10:00:00Z',
    message: { id: 'm' + i, model: 'm', usage: { input_tokens: i, output_tokens: 0 }, content: [] } });
  // One complete record (counted) plus a long unterminated partial line, so the
  // consumed offset stops far below the file size — this is what makes the weak
  // `size >= offset` guard exploitable.
  writeFileSync(path, rec(10) + '\n' + 'x'.repeat(2000));
  const prev = parseTranscript(path);
  assert.equal(prev.inputTokens, 10, 'only the complete line counted');
  assert.ok(prev._offset < prev._size, 'trailing partial leaves offset below size');

  // Rewrite the whole file with different, smaller content whose size lands
  // between the old offset and the old size — the window the old guard would
  // have wrongly treated as an append onto stale counts.
  writeFileSync(path, rec(3) + '\n' + rec(0) + '\n');
  const sz = statSync(path).size;
  assert.ok(sz > prev._offset && sz < prev._size, 'rewrite size sits in the danger window');

  const after = parseTranscript(path, prev);
  assert.equal(after.inputTokens, 3, 'full re-parse: only the rewritten content, no stale 10 carried over');
  assert.equal(after.inputTokens, parseTranscript(path).inputTokens, 'matches a from-scratch parse');
  rmSync(dir, { recursive: true });
});

test('aggregateFrom: subagent active time is tracked separately, not folded into activeMs', () => {
  // Two cached summaries: one top-level session, one subagent run. activeMs must
  // stay an interactive-session measure (top-level only), while subagent active
  // time surfaces in its own field — see the ACTIVE_GAP_CAP_MS double-count note
  // in scanner.js. isSubagent is set explicitly so this doesn't depend on paths.
  const agg = aggregateFrom({
    files: {
      '/p/top.jsonl': { isSubagent: false, activeMs: 1000, firstTs: 1700000000000, lastTs: 1700000001000 },
      '/p/uuid/subagents/agent-1.jsonl': { isSubagent: true, activeMs: 500 },
    },
  });
  assert.equal(agg.activeMs, 1000, 'activeMs counts the top-level session only');
  assert.equal(agg.subagentActiveMs, 500, 'subagent active time tracked separately');
  assert.equal(agg.sessions, 1, 'a subagent is not a session');
  assert.equal(agg.subagentRuns, 1, 'subagent run counted');
});

// ── ships (v5 cache: per-day ship counts + project attribution) ───────

test('parseTranscript: classifies shipped Bash commands into ships/shipKinds', async () => {
  const { dayKey } = await import('../src/scanner.js');
  const ts = '2026-05-22T10:00:30Z';
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z',
      message: { content: 'ship it' } },
    { type: 'assistant', timestamp: ts,
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'git add . && git commit -m "fix: x"' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'git push origin main' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'echo "git push later"' } },
        ] } },
  ]);
  const s = parseTranscript(path);
  assert.equal(s.ships, 2, 'quoted mention must not classify');
  assert.deepEqual(s.shipKinds, { commit: 1, push: 1 });
  const bucket = s.byDay[dayKey(Date.parse(ts))];
  assert.equal(bucket.ships, 2);
  assert.deepEqual(bucket.shipKinds, { commit: 1, push: 1 });
  rmSync(dir, { recursive: true });
});

test('aggregateFrom: rolls up ships and attributes per-day projects', async () => {
  const { dayKey } = await import('../src/scanner.js');
  const ts = '2026-05-22T10:00:30Z';
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z',
      message: { content: 'go' } },
    { type: 'assistant', timestamp: ts,
      message: { model: 'claude-opus-4-7', usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr create --fill' } }] } },
  ]);
  const s = parseTranscript(path);
  const agg = aggregateFrom({ files: { [path]: s } });
  assert.equal(agg.ships, 1);
  assert.deepEqual(agg.shipKinds, { pr: 1 });
  const bucket = agg.byDay[dayKey(Date.parse(ts))];
  assert.equal(bucket.ships, 1);
  assert.equal(bucket.projects.proj.tokens, 150, 'day tokens attributed to the session project');
  rmSync(dir, { recursive: true });
});

// ── v7 cache: per-day model buckets + session-length distribution ──────

test('parseTranscript + aggregateFrom: per-day byModel buckets carry turns/tokens/cost', async () => {
  const { dayKey } = await import('../src/scanner.js');
  const d1 = '2026-05-22T10:00:30Z';
  const d2 = '2026-05-23T11:00:30Z';
  const { dir, path } = makeTranscript([
    { type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z',
      message: { content: 'go' } },
    { type: 'assistant', timestamp: d1,
      message: { id: 'a1', model: 'claude-opus-4-7', usage: { input_tokens: 100, output_tokens: 50 } } },
    { type: 'assistant', timestamp: d2,
      message: { id: 'a2', model: 'claude-sonnet-4-5', usage: { input_tokens: 200, output_tokens: 10 } } },
  ]);
  const s = parseTranscript(path);
  const agg = aggregateFrom({ files: { [path]: s } });
  const day1 = agg.byDay[dayKey(Date.parse(d1))].byModel;
  const day2 = agg.byDay[dayKey(Date.parse(d2))].byModel;
  assert.ok(day1 && day2, 'both days carry a byModel bucket');
  const k1 = Object.keys(day1), k2 = Object.keys(day2);
  assert.equal(k1.length, 1, 'day 1 saw one model');
  assert.equal(day1[k1[0]].tokens, 150);
  assert.equal(day1[k1[0]].turns, 1);
  assert.ok(day1[k1[0]].cost > 0, 'per-day model cost accrues');
  assert.notEqual(k1[0], k2[0], 'the switch shows up as different day-model keys');
  assert.equal(day2[k2[0]].tokens, 210);
  rmSync(dir, { recursive: true });
});

test('aggregateFrom: session-length histogram buckets ACTIVE durations (not wall clock)', () => {
  const HOUR = 3_600_000;
  const t0 = 1700000000000;
  // Wall clock spans a week (a session left open) — only activeMs counts.
  const mk = (activeMs) => ({ isSubagent: false, activeMs, firstTs: t0, lastTs: t0 + 7 * 24 * HOUR });
  const agg = aggregateFrom({
    files: {
      '/p/a.jsonl': mk(5 * 60_000),        // <15m
      '/p/b.jsonl': mk(45 * 60_000),       // 30–60m
      '/p/c.jsonl': mk(3 * HOUR),          // 2–4h (marathon)
      '/p/d.jsonl': mk(6 * HOUR),          // >4h (longest)
      '/p/idle.jsonl': { isSubagent: false, activeMs: 0, firstTs: t0, lastTs: t0 + HOUR }, // no active work — not a sitting
      '/p/uuid/subagents/agent-1.jsonl': { isSubagent: true, activeMs: 9 * HOUR, firstTs: t0, lastTs: t0 + 9 * HOUR },
    },
  });
  const sl = agg.sessionLengths;
  assert.equal(sl.count, 4, 'subagents and zero-active sessions are not sittings');
  assert.equal(sl.buckets.lt15m, 1);
  assert.equal(sl.buckets.m30to60, 1);
  assert.equal(sl.buckets.h2to4, 1);
  assert.equal(sl.buckets.gt4h, 1);
  assert.equal(sl.longestMs, 6 * HOUR, 'week-long wall clock does not own the record; neither does the subagent');
  assert.equal(sl.totalMs, 5 * 60_000 + 45 * 60_000 + 9 * HOUR);
});

test('parseTranscript: tiny read chunks give the same result as one big read', () => {
  // Multi-byte text (accented letters, an emoji) so chunk edges land mid-character,
  // plus a line far longer than the chunk, plus a partial trailing line.
  const wide = String.fromCodePoint(0xe9, 0x4e2d, 0x1f680).repeat(40);
  const recs = [{ type: 'user', sessionId: 's1', cwd: '/tmp/proj', timestamp: '2026-05-22T10:00:00Z', message: { content: wide } }];
  for (let i = 0; i < 6; i++) {
    recs.push({ type: 'assistant', timestamp: `2026-05-22T10:0${i}:30Z`,
      message: { id: `m${i}`, model: 'claude-opus-4-7', usage: { input_tokens: 10 + i, output_tokens: 5 },
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/x.js', content: wide + '\n' + wide } }] } });
  }
  const { dir, path } = makeTranscript(recs);
  appendFileSync(path, '{"type":"assistant","partial');
  const whole = parseTranscript(path);
  for (const chunkBytes of [1, 3, 7, 64, 1000]) {
    assert.deepEqual(parseTranscript(path, null, { chunkBytes }), whole, `chunkBytes=${chunkBytes}`);
  }
  assert.equal(whole.inputTokens, 75);
  rmSync(dir, { recursive: true });
});
