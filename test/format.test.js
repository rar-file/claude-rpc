// applyIdle and buildVars — the two functions every push tick depends on.
// applyIdle decides what the visible status is; buildVars produces the
// template-substitution table. Bugs here = wrong card text or stuck states.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applyIdle, applyShipped, buildVars, fillTemplate, framePasses } = await import('../src/format.js');

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

// ── close-detection: fast clear vs idle-when-open (v0.9.1 default flip) ──
//
// SessionEnd doesn't fire on terminal-close / force-quit / crash, so "no
// transcripts are being written to disk" is the only passive signal that
// Claude Code is gone. DEFAULT (idleWhenOpen omitted/false): clear within
// ~90-120s of the transcript going quiet — closing the terminal shouldn't
// leave a card up for 5 minutes. Opt in with idleWhenOpen:true to instead
// linger as 'idle' until the staleMs backstop (keeps the card up through
// short pauses with the terminal still open).

test('applyIdle: status=idle + no live sessions → stale by default (fast clear)', () => {
  const s = baseState({ status: 'idle', lastActivity: now() - 30_000, liveSessions: [] });
  const r = applyIdle(s, { staleSessionMin: 5, idleThresholdSec: 60 });
  assert.equal(r.status, 'stale', 'no transcripts ≡ Claude gone → clear');
  assert.equal(r.cwd, '', 'cwd wiped so {project} stops leaking');
});

test('applyIdle: status=idle + no live sessions + idleWhenOpen:true → stays idle', () => {
  const s = baseState({ status: 'idle', lastActivity: now() - 30_000, liveSessions: [] });
  const r = applyIdle(s, { staleSessionMin: 5, idleThresholdSec: 60, idleWhenOpen: true });
  assert.equal(r.status, 'idle', 'opt-in keeps the card up through a pause');
});

test('applyIdle: status=idle WITH live sessions stays idle (even by default)', () => {
  const recent = now() - 30_000;
  const s = baseState({ status: 'idle', lastActivity: now() - 30_000,
    liveSessions: [{ cwd: '/p', mtime: recent }] });
  const r = applyIdle(s, { staleSessionMin: 5, idleThresholdSec: 60 });
  assert.equal(r.status, 'idle', 'a live transcript means the user is still here');
});

test('applyIdle: working past idleMs + no live sessions → stale by default', () => {
  const past = now() - 90_000; // 90s ago, past idleMs=60s but well under staleMs=5min
  const s = baseState({ status: 'working', lastActivity: past, liveSessions: [] });
  const r = applyIdle(s, { staleSessionMin: 5, idleThresholdSec: 60 });
  assert.equal(r.status, 'stale', 'no transcripts → clear without waiting staleMs');
  assert.equal(r.cwd, '');
});

test('applyIdle: working past idleMs + no live sessions + idleWhenOpen:true → idle', () => {
  const past = now() - 90_000;
  const s = baseState({ status: 'working', lastActivity: past, liveSessions: [] });
  const r = applyIdle(s, { staleSessionMin: 5, idleThresholdSec: 60, idleWhenOpen: true });
  assert.equal(r.status, 'idle', 'opt-in: drops to idle instead of clearing');
});

test('applyIdle: dormant past staleMs → stale even with idleWhenOpen:true', () => {
  const past = now() - 6 * 60_000; // 6min, past staleMs=5min
  const s = baseState({ status: 'working', lastActivity: past, liveSessions: [] });
  const r = applyIdle(s, { staleSessionMin: 5, idleThresholdSec: 60, idleWhenOpen: true });
  assert.equal(r.status, 'stale', 'dormancy backstop clears even the opt-in idle-stay');
  assert.equal(r.cwd, '');
});

test('applyIdle: working past idleMs + live sessions present → idle (not stale)', () => {
  const past = now() - 90_000;
  const recent = now() - 30_000;
  const s = baseState({ status: 'working', lastActivity: past,
    liveSessions: [{ cwd: '/p', mtime: recent }] });
  const r = applyIdle(s, { staleSessionMin: 5, idleThresholdSec: 60 });
  // liveAgeMs (30s) <= idleMs (60s) → keep working, transcript is hot.
  assert.equal(r.status, 'working');
});

// ── username-leak suppression (v0.6.2) ─────────────────────────────────

test('buildVars: cwd === home dir suppresses the username', () => {
  const origHome = process.env.HOME;
  const origUser = process.env.USER;
  process.env.HOME = '/home/lucas';
  process.env.USER = 'lucas';
  try {
    const s = baseState({ cwd: '/home/lucas' });
    const v = buildVars(s, { appName: 'Claude Code' }, {});
    assert.equal(v.project, 'Claude Code', 'home-dir cwd renders as appName');
    assert.notEqual(v.project, 'lucas', 'username never appears');
    assert.equal(v.cwd, '', 'raw cwd also suppressed (custom templates use {cwd})');
  } finally {
    process.env.HOME = origHome;
    process.env.USER = origUser;
  }
});

test('buildVars: basename(cwd) matching $USER also triggers suppression', () => {
  const origUser = process.env.USER;
  process.env.USER = 'lucas';
  try {
    const s = baseState({ cwd: '/anywhere/else/lucas' });
    const v = buildVars(s, { appName: 'Claude Code' }, {});
    assert.equal(v.project, 'Claude Code');
  } finally {
    process.env.USER = origUser;
  }
});

test('buildVars: real project name unaffected by the leak check', () => {
  const origUser = process.env.USER;
  process.env.USER = 'lucas';
  try {
    const s = baseState({ cwd: '/home/lucas/my-project' });
    const v = buildVars(s, {}, {});
    assert.equal(v.project, 'my-project');
    assert.equal(v.cwd, '/home/lucas/my-project');
  } finally {
    process.env.USER = origUser;
  }
});

test('buildVars: Windows-style USERPROFILE triggers suppression', () => {
  const origProfile = process.env.USERPROFILE;
  const origUsername = process.env.USERNAME;
  process.env.USERPROFILE = 'C:\\Users\\lucas';
  process.env.USERNAME = 'lucas';
  try {
    const s = baseState({ cwd: 'C:\\Users\\lucas' });
    const v = buildVars(s, {}, {});
    assert.equal(v.project, 'Claude Code', 'Windows home dir suppressed');
  } finally {
    process.env.USERPROFILE = origProfile;
    process.env.USERNAME = origUsername;
  }
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

test('fillTemplate: collapses orphan separators from empty vars', () => {
  // Bash has no file_path → currentFilePretty empty. tokensLabel empty
  // before any tokens accrue. The naive substitution would yield
  // "Bash ·  · " — the collapse turns that into just "Bash".
  const tpl = '{tool} · {file} · {tokens}';
  assert.equal(fillTemplate(tpl, { tool: 'Bash', file: '', tokens: '' }), 'Bash');
  assert.equal(fillTemplate(tpl, { tool: 'Bash', file: '', tokens: '2.3k tokens' }),
    'Bash · 2.3k tokens');
  assert.equal(fillTemplate(tpl, { tool: 'Edit', file: 'src/foo.js', tokens: '2.3k tokens' }),
    'Edit · src/foo.js · 2.3k tokens');
});

test('fillTemplate: template with no `·` is unchanged', () => {
  // The collapse only runs on `·`-separated templates so non-separator
  // templates pass through untouched (no accidental whitespace munging).
  assert.equal(fillTemplate('Hello {name}', { name: 'world' }), 'Hello world');
  assert.equal(fillTemplate('  spaces  preserved  ', {}), '  spaces  preserved  ');
});

test('buildVars: tokensLabel is empty when sessionTokens=0', () => {
  // The reason "Bash · · 0 tokens" used to render. tokensLabel now hides
  // the metric until it's meaningful.
  const s = baseState({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  const v = buildVars(s, {}, {});
  assert.equal(v.tokensLabel, '');
});

test('buildVars: tokensLabel renders "X tokens" when present', () => {
  const s = baseState({ tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 } });
  const v = buildVars(s, {}, {});
  assert.match(v.tokensLabel, /1\.5k tokens$/);
});

// ── compaction vars (v0.7) ─────────────────────────────────────────────

test('buildVars: compactTriggerLabel humanizes the trigger', () => {
  assert.equal(
    buildVars(baseState({ status: 'compacting', compactTrigger: 'auto' }), {}, {}).compactTriggerLabel,
    'auto-compaction',
  );
  assert.equal(
    buildVars(baseState({ status: 'compacting', compactTrigger: 'manual' }), {}, {}).compactTriggerLabel,
    'manual compaction',
  );
  // No trigger info still produces a usable label (avoids "Compacting · " orphans).
  assert.equal(
    buildVars(baseState({ status: 'compacting' }), {}, {}).compactTriggerLabel,
    'context squeeze',
  );
});

test('buildVars: compactMs measures elapsed since PreCompact', () => {
  const startedAt = Date.now() - 12_000;
  const v = buildVars(baseState({ status: 'compacting', compactStartedAt: startedAt }), {}, {});
  assert.ok(v.compactMs >= 11_000 && v.compactMs <= 13_000, 'elapsed within window');
  assert.match(v.compactDuration, /^12s$|^11s$|^13s$/, 'fmtDuration rendered the seconds');
});

test('buildVars: compactDuration empty when no compaction active', () => {
  const v = buildVars(baseState({ status: 'working', compactStartedAt: null }), {}, {});
  assert.equal(v.compactDuration, '', 'empty so it collapses out of templates');
  assert.equal(v.compactMs, 0);
});

test('buildVars: statusVerbose handles compacting', () => {
  const v = buildVars(baseState({ status: 'compacting' }), {}, {});
  assert.equal(v.statusVerbose, 'Compacting context');
});

// ── tool-duration spotlight (v0.7) ─────────────────────────────────────

const { fmtToolElapsed } = await import('../src/format.js');

test('fmtToolElapsed: sub-minute → bare seconds', () => {
  assert.equal(fmtToolElapsed(0), '');
  assert.equal(fmtToolElapsed(5_000), '5s');
  assert.equal(fmtToolElapsed(45_000), '45s');
  assert.equal(fmtToolElapsed(59_999), '59s');
});

test('fmtToolElapsed: sub-10min → decimal minutes', () => {
  assert.equal(fmtToolElapsed(60_000), '1.0min');
  assert.equal(fmtToolElapsed(90_000), '1.5min');
  assert.equal(fmtToolElapsed(150_000), '2.5min');
});

test('fmtToolElapsed: ≥10min → integer minutes', () => {
  assert.equal(fmtToolElapsed(600_000), '10min');
  assert.equal(fmtToolElapsed(900_000), '15min');
});

test('fmtToolElapsed: hour+ → "Xh Ym"', () => {
  assert.equal(fmtToolElapsed(3_600_000), '1h 0m');
  assert.equal(fmtToolElapsed(3_660_000), '1h 1m');
  assert.equal(fmtToolElapsed(7_200_000), '2h 0m');
});

test('buildVars: toolElapsed empty under 5s threshold', () => {
  const s = baseState({ status: 'working', toolStartedAt: Date.now() - 2_000 });
  const v = buildVars(s, {}, {});
  assert.equal(v.toolElapsed, '', 'quick tools never flicker on the card');
});

test('buildVars: toolElapsed populated past threshold', () => {
  const s = baseState({ status: 'working', toolStartedAt: Date.now() - 30_000 });
  const v = buildVars(s, {}, {});
  assert.match(v.toolElapsed, /^(2[89]|3[01])s$/, 'rendered seconds');
});

test('buildVars: toolElapsed empty when not working', () => {
  const s = baseState({ status: 'idle', toolStartedAt: Date.now() - 30_000 });
  const v = buildVars(s, {}, {});
  assert.equal(v.toolElapsed, '', 'idle state suppresses the timer');
});

// ── just-shipped overlay (v0.7) ────────────────────────────────────────

test('applyShipped: within window promotes status to shipped', () => {
  const s = baseState({ status: 'idle', justShipped: Date.now() - 10_000, justShippedKind: 'push' });
  const r = applyShipped(s, { shippedFrameSec: 60 });
  assert.equal(r.status, 'shipped');
});

test('applyShipped: past window falls back to underlying status', () => {
  const s = baseState({ status: 'idle', justShipped: Date.now() - 120_000, justShippedKind: 'push' });
  const r = applyShipped(s, { shippedFrameSec: 60 });
  assert.equal(r.status, 'idle', 'expired overlay leaves state unchanged');
});

test('applyShipped: stale always wins (no celebration when Claude is closed)', () => {
  const s = baseState({ status: 'stale', justShipped: Date.now() - 5_000, justShippedKind: 'push' });
  const r = applyShipped(s, { shippedFrameSec: 60 });
  assert.equal(r.status, 'stale');
});

test('applyShipped: no justShipped is a no-op', () => {
  const s = baseState({ status: 'working' });
  const r = applyShipped(s, { shippedFrameSec: 60 });
  assert.equal(r, s, 'returns the same object reference');
});

test('applyShipped: respects custom shippedFrameSec', () => {
  const s = baseState({ status: 'idle', justShipped: Date.now() - 20_000, justShippedKind: 'push' });
  // Window of 10s — 20s ago already expired.
  assert.equal(applyShipped(s, { shippedFrameSec: 10 }).status, 'idle');
  // Window of 30s — 20s ago still in.
  assert.equal(applyShipped(s, { shippedFrameSec: 30 }).status, 'shipped');
});

test('buildVars: justShippedLabel renders branch-aware verb', () => {
  const push = baseState({ justShippedKind: 'push', justShippedBranch: 'main' });
  assert.equal(buildVars(push, {}, {}).justShippedLabel, 'Pushed to main');

  const commit = baseState({ justShippedKind: 'commit', justShippedBranch: 'feat/x' });
  assert.equal(buildVars(commit, {}, {}).justShippedLabel, 'Committed on feat/x');

  // Detached HEAD / unknown branch — falls back to a bare verb.
  const detached = baseState({ justShippedKind: 'push', justShippedBranch: null });
  assert.equal(buildVars(detached, {}, {}).justShippedLabel, 'Pushed');

  // No kind set — empty (so the `·` collapse hides it in templates).
  assert.equal(buildVars(baseState(), {}, {}).justShippedLabel, '');
});

test('buildVars: lastCommit aliases justShippedSubject', () => {
  const s = baseState({ justShippedSubject: 'wire compaction frame' });
  assert.equal(buildVars(s, {}, {}).lastCommit, 'wire compaction frame');
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

// ── v0.9 buildVars additions ───────────────────────────────────────────

test('buildVars: justShippedLabel covers pr / issue / tag', () => {
  const pr = buildVars(baseState({ justShippedKind: 'pr' }), {}, {});
  assert.equal(pr.justShippedLabel, 'Opened a pull request');
  const issue = buildVars(baseState({ justShippedKind: 'issue' }), {}, {});
  assert.equal(issue.justShippedLabel, 'Opened an issue');
  const tag = buildVars(baseState({ justShippedKind: 'tag', justShippedBranch: 'v1.0' }), {}, {});
  assert.equal(tag.justShippedLabel, 'Tagged v1.0');
});

test('buildVars: model split label from aggregate.modelSplit', () => {
  const agg = { modelSplit: [
    { model: 'opus',   cost: 90, costPct: 0.75, tokens: 100 },
    { model: 'sonnet', cost: 30, costPct: 0.25, tokens: 50 },
  ] };
  const v = buildVars(baseState(), {}, agg);
  assert.match(v.modelSplitLabel, /75%/);
  assert.match(v.modelSplitLabel, /25%/);
  assert.equal(v.topModelCostPct, 75);
  assert.ok(v.topModelShareLabel.includes('75% of spend'));
});

test('buildVars: hotspot aging label', () => {
  const mk = (days) => buildVars(baseState(), {}, { topEditedFiles: [{ path: '/a/page.js', count: 7, daysSinceLastEdit: days }] });
  assert.equal(mk(0).topEditedAgeLabel, 'edited today');
  assert.equal(mk(1).topEditedAgeLabel, 'edited yesterday');
  assert.equal(mk(14).topEditedAgeLabel, '14d since last edit');
  assert.equal(mk(0).topEditedDaysAgo, 0);
});

test('buildVars: billable-vs-cache breakdown', () => {
  const agg = { inputTokens: 100, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0 };
  const v = buildVars(baseState(), {}, agg);
  assert.equal(v.allFreshTokens, 200);
  assert.equal(v.allCachePct, 80);
  assert.equal(v.allCachePctLabel, '80% from cache');
});

test('buildVars: session milestone fires within window, not outside', () => {
  // 2h + 1min into the session → milestone hit.
  const hit = buildVars(baseState({ sessionStart: now() - (2 * 3_600_000 + 60_000) }), {}, {});
  assert.equal(hit.sessionMilestoneHit, 1);
  assert.equal(hit.sessionMilestoneLabel, '2-hour session');
  // 2h + 10min → past the 5min window, no milestone.
  const miss = buildVars(baseState({ sessionStart: now() - (2 * 3_600_000 + 10 * 60_000) }), {}, {});
  assert.equal(miss.sessionMilestoneHit, 0);
  assert.equal(miss.sessionMilestoneLabel, '');
});
