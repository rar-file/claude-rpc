// applyIdle and buildVars — the two functions every push tick depends on.
// applyIdle decides what the visible status is; buildVars produces the
// template-substitution table. Bugs here = wrong card text or stuck states.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applyIdle, buildVars, fillTemplate, framePasses } = await import('../src/format.js');

const now = () => Date.now();

function baseState(overrides = {}) {
  return {
    sessionStart: now(),
    lastActivity: now(),
    status: 'working',
    cwd: '/tmp/proj',
    model: 'claude-opus-4-7',
    messages: 1,
    tools: 1,
    filesEdited: [],
    filesRead: [],
    filesOpened: [],
    tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
    toolBreakdown: {},
    claudeClosed: false,
    ...overrides,
  };
}

// ── applyIdle ──────────────────────────────────────────────────────────

test('applyIdle: claudeClosed=true returns stale immediately', () => {
  const s = baseState({ claudeClosed: true, lastActivity: now() });
  const r = applyIdle(s, { staleSessionMin: 5 });
  assert.equal(r.status, 'stale');
  assert.equal(r.cwd, '');
  assert.equal(r.messages, 0);
  assert.equal(r.currentTool, null);
  assert.equal(r.claudeClosed, true, 'flag preserved through subsequent ticks');
});

test('applyIdle: working stays working with fresh activity', () => {
  const s = baseState({ status: 'working' });
  const r = applyIdle(s, { staleSessionMin: 5 });
  assert.equal(r.status, 'working');
});

test('applyIdle: notification expires after window', () => {
  const past = now() - 30_000;
  const s = baseState({ status: 'notification', lastNotification: past });
  const r = applyIdle(s, { notificationWindowSec: 8, staleSessionMin: 5 });
  assert.notEqual(r.status, 'notification', 'should fall through after window');
});

test('applyIdle: stale when no activity AND no live sessions', () => {
  const past = now() - 10 * 60 * 1000; // 10 minutes ago
  const s = baseState({ lastActivity: past, liveSessions: [] });
  const r = applyIdle(s, { staleSessionMin: 5 });
  assert.equal(r.status, 'stale');
});

test('applyIdle: borrows live transcript when local state stale', () => {
  const past = now() - 10 * 60 * 1000;
  const recent = now() - 30_000;
  const s = baseState({
    lastActivity: past,
    liveSessions: [{ cwd: '/tmp/other', mtime: recent }],
  });
  const r = applyIdle(s, { staleSessionMin: 5 });
  assert.equal(r.status, 'working', 'should resurrect from disk activity');
  assert.equal(r.cwd, '/tmp/other');
});

test('applyIdle: respects legacy state with no claudeClosed field', () => {
  const s = baseState();
  delete s.claudeClosed;
  const r = applyIdle(s, { staleSessionMin: 5 });
  assert.equal(r.status, 'working', 'undefined flag is falsy, no crash');
});

// ── buildVars ──────────────────────────────────────────────────────────

test('buildVars: produces core session vars', () => {
  const s = baseState({ currentTool: 'Edit', currentFile: 'src/scanner.js' });
  const vars = buildVars(s, { appName: 'Claude Code' }, {});
  assert.equal(vars.project, 'proj');
  assert.equal(vars.modelPretty, 'Opus 4.7');
  assert.equal(vars.currentToolPretty, 'Edit');
  assert.equal(vars.currentFilePretty, 'src/scanner.js');
  assert.equal(vars.messages, 1);
  assert.equal(vars.appName, 'Claude Code');
});

test('buildVars: derives fileLang/fileExt from currentFile', () => {
  const s = baseState({ currentFile: 'src/foo/bar.tsx' });
  const vars = buildVars(s, {}, {});
  assert.equal(vars.fileExt, '.tsx');
  assert.equal(vars.fileLang, 'TypeScript');
  assert.equal(vars.fileLangUpper, 'TYPESCRIPT');
  assert.equal(vars.dirName, 'foo');
});

test('buildVars: token total includes cache', () => {
  const s = baseState({
    tokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 5 },
  });
  const vars = buildVars(s, {}, {});
  assert.equal(vars.tokens, 175, 'grand total includes all four buckets');
});

test('buildVars: aggregate vars zeroed when no aggregate', () => {
  const vars = buildVars(baseState(), {}, null);
  assert.equal(vars.allSessions, 0);
  assert.equal(vars.allHours, '0h');
  // Empty streak renders as "no streak" (the friendly fallback) rather than
  // a literal "0 days" — better for the card.
  assert.equal(vars.streakLabel, 'no streak');
});

// ── fillTemplate ───────────────────────────────────────────────────────

test('fillTemplate: substitutes known vars', () => {
  const out = fillTemplate('Hello {name}!', { name: 'world' });
  assert.equal(out, 'Hello world!');
});

test('fillTemplate: leaves unknown vars as-is', () => {
  const out = fillTemplate('Hello {unknown}', { name: 'world' });
  assert.equal(out, 'Hello {unknown}');
});

test('fillTemplate: passes non-string through', () => {
  assert.equal(fillTemplate(null, {}), null);
  assert.equal(fillTemplate(undefined, {}), undefined);
  assert.equal(fillTemplate(42, {}), 42);
});

// ── framePasses ────────────────────────────────────────────────────────

test('framePasses: no requires → always true', () => {
  assert.equal(framePasses({}, {}), true);
});

test('framePasses: requires array fails on any empty/zero value', () => {
  const vars = { a: 1, b: 0, c: '' };
  assert.equal(framePasses({ requires: 'a' }, vars), true);
  assert.equal(framePasses({ requires: 'b' }, vars), false, 'zero is falsy');
  assert.equal(framePasses({ requires: 'c' }, vars), false, 'empty string is falsy');
  assert.equal(framePasses({ requires: ['a', 'b'] }, vars), false, 'any falsy fails');
});

test('framePasses: em-dash counts as falsy (used for empty fallbacks)', () => {
  assert.equal(framePasses({ requires: 'x' }, { x: '—' }), false);
});

// ── humanModel / humanTool / humanProject ──────────────────────────────

const { humanModel, humanTool, humanProject, fmtNum, fmtDuration, fmtHours, plural } =
  await import('../src/format.js');

test('humanModel maps version-tagged ids to friendly names', () => {
  assert.equal(humanModel('claude-opus-4-7'), 'Opus 4.7');
  assert.equal(humanModel('claude-sonnet-4-6-20250514'), 'Sonnet 4.6');
  assert.equal(humanModel('claude-haiku-4-5'), 'Haiku 4.5');
});

test('humanModel falls back to tier-only when no version', () => {
  assert.equal(humanModel('claude-opus'), 'Opus');
  assert.equal(humanModel('unknown-model'), 'Claude');
  assert.equal(humanModel(''), 'Claude');
  assert.equal(humanModel(null), 'Claude');
});

test('humanTool strips MCP prefix and exposes server:action', () => {
  assert.equal(humanTool('mcp__claude_ai_Vercel__deploy_to_vercel'), 'Vercel:deploy_to_vercel');
  assert.equal(humanTool('mcp__github__list'), 'github:list');
  assert.equal(humanTool('Edit'), 'Edit');
  assert.equal(humanTool(''), '');
  assert.equal(humanTool(null), '');
});

test('humanProject strips date suffixes and slug shapes', () => {
  assert.equal(humanProject('/home/user/projects/my-app'), 'my-app');
  assert.equal(humanProject('archive-2026-04-25T185311Z'), 'archive');
  // Claude Code's slugs replace `/` with `-`, so a slug-shaped string
  // gets last-segment treatment. (Hyphenated project names like `my-app`
  // become ambiguous in this shape — see scanner.cleanProjectName for
  // the matching round-trip on the wire.)
  assert.equal(humanProject('-home-alice-projects-foo'), 'foo');
  assert.equal(humanProject(''), '');
});

test('fmtNum scales by suffix', () => {
  assert.equal(fmtNum(0), '0');
  assert.equal(fmtNum(999), '999');
  assert.equal(fmtNum(1500), '1.5k');
  assert.equal(fmtNum(1_500_000), '1.50M');
  assert.match(fmtNum(2_500_000_000), /^2\.\d+B$/);
});

test('fmtDuration uses hours/minutes/seconds', () => {
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(45_000), '45s');
  assert.match(fmtDuration(3 * 60 * 1000), /^3m/);
  assert.match(fmtDuration(2 * 3600_000), /^2h/);
});

test('fmtHours: <1h → minutes, <10h → decimal, ≥10h → integer', () => {
  assert.equal(fmtHours(30 * 60_000), '30m');
  assert.equal(fmtHours(2.5 * 3600_000), '2.5h');
  assert.equal(fmtHours(12 * 3600_000), '12h');
  assert.equal(fmtHours(0), '0h');
});

test('plural picks singular when n=1', () => {
  assert.equal(plural(1, 'prompt'), '1 prompt');
  assert.equal(plural(2, 'prompt'), '2 prompts');
  assert.equal(plural(0, 'prompt'), '0 prompts');
  assert.equal(plural(1, 'edit', 'edits'), '1 edit');
});
