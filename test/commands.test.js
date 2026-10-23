// The command table (src/commands.js) drives help, tab completion and typo
// hints; cli.js's switch does the dispatch. These tests keep the two in step
// and pin the completion / statcards / png helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { COMMANDS, allNames, findCommand, complete, suggestCommand, ALIAS_HINT, FILES } = await import('../src/commands.js');
const completion = await import('../src/completion.js');
const { parseArgs, snippets, CARDS } = await import('../src/statcards.js');
const { svgSize, rasterArgs, findRasterizer, svgToPng } = await import('../src/png.js');

const cliSrc = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
const dispatchSrc = cliSrc.slice(cliSrc.indexOf('switch (cmd) {'));
const cases = new Set([...dispatchSrc.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]));

test('commands: every name in the table is dispatched by cli.js', () => {
  for (const n of allNames()) assert.ok(cases.has(n), `\`${n}\` is in commands.js but cli.js has no case for it`);
});

test('commands: every dispatched name is in the table', () => {
  const known = new Set(allNames());
  for (const n of cases) assert.ok(known.has(n), `cli.js dispatches \`${n}\` but commands.js doesn't list it`);
});

test('commands: names and aliases are unique; every alias has a hint', () => {
  const seen = new Set();
  for (const c of COMMANDS) {
    for (const n of [c.name, ...(c.aliases || [])]) {
      assert.ok(!seen.has(n), `duplicate ${n}`);
      seen.add(n);
    }
    for (const a of c.aliases || []) assert.ok(ALIAS_HINT[a], `alias ${a} has no ALIAS_HINT`);
  }
});

test('commands: every stable CLI name from VERSIONING.md still resolves', () => {
  for (const n of ['start', 'stop', 'restart', 'daemon', 'setup', 'install', 'uninstall', 'upgrade-config', 'status', 'dump',
    'today', 'week', 'compare', 'projects', 'project', 'usage', 'preview', 'scan', 'rescan', 'backfill', 'export', 'insights',
    'recap', 'vars', 'badge', 'card', 'github-stat', 'statusline', 'calendar', 'session-card', 'readme', 'mcp', 'serve',
    'wrapped', 'pause', 'resume', 'unpause', 'private', 'public', 'privacy', 'community', 'profile', 'squad', 'link',
    'doctor', 'tail', 'log', 'logs']) {
    assert.ok(findCommand(n), `${n} no longer resolves`);
  }
});

test('complete: command names by prefix, with descriptions', () => {
  const out = complete(['re']);
  assert.deepEqual(out.map((l) => l.split('\t')[0]), ['recap', 'restart']);
  assert.ok(out[0].includes('\t'));
  assert.ok(!complete(['']).some((l) => l.startsWith('hook') || l.startsWith('__complete')), 'internals stay hidden');
});

test('complete: flags, flag values, subs, project names, files', () => {
  assert.deepEqual(complete(['scan', '-']).map((l) => l.split('\t')[0]), ['--force']);
  assert.deepEqual(complete(['statcards', 'badge', '--metric', '']), ['hours', 'tokens', 'streak', 'sessions']);
  assert.deepEqual(complete(['statcards', 'poster', '--png', '']), [FILES]);
  assert.ok(complete(['pause', '']).some((l) => l.startsWith('off')));
  assert.deepEqual(complete(['projects', 'cl'], { projects: () => ['claude-rpc', 'api', 'cli'] }), ['claude-rpc', 'cli']);
  assert.deepEqual(complete(['backfill', '']), [FILES]);
  assert.deepEqual(complete(['statcards', 'badge', '']), [], 'one card only');
  assert.deepEqual(complete(['nope', '']), []);
  // An alias completes like its command.
  assert.ok(complete(['rescan', '--f']).some((l) => l.startsWith('--force')));
  // Flags already typed aren't offered again.
  assert.ok(!complete(['statcards', '--md', '--']).some((l) => l.startsWith('--md')));
});

test('suggestCommand: unique prefixes, typos, nothing for junk', () => {
  assert.equal(suggestCommand('statc'), 'statcards');
  assert.equal(suggestCommand('stauts'), 'status');
  assert.equal(suggestCommand('rescna'), 'rescan');
  assert.equal(suggestCommand('zzzzzzzz'), null);
});

test('help: lists every visible command and renders per-command pages', async () => {
  const { renderHelp, renderCommandHelp } = await import('../src/help.js');
  const page = renderHelp();
  for (const c of COMMANDS.filter((x) => x.group)) assert.ok(page.includes(c.name), `${c.name} missing from help`);
  assert.ok(!page.includes('github-stat'), 'old names stay out of the list');
  assert.match(renderCommandHelp('statcards'), /--png/);
  assert.match(renderCommandHelp('compare'), /week --compare/);
  assert.equal(renderCommandHelp('nope'), null);
});

test('completion: rc block is idempotent and removable', () => {
  const line = "[ -f '/x/claude-rpc.zsh' ] && . '/x/claude-rpc.zsh'";
  const once = completion.withBlock('export A=1\n', line);
  assert.equal(completion.withBlock(once, line), once);
  assert.equal(completion.withoutBlock(once), 'export A=1\n');
  assert.equal(completion.withoutBlock('nothing here\n'), 'nothing here\n');
  assert.ok(completion.withBlock('no newline', line).startsWith('no newline\n# >>>'));
});

test('completion: every shell script asks __complete; install/uninstall round-trip', () => {
  for (const sh of ['bash', 'zsh', 'fish', 'powershell']) assert.match(completion.scriptFor(sh), /__complete/);
  assert.equal(completion.scriptFor('tcsh'), null);
  assert.equal(completion.detectShell({ SHELL: '/usr/bin/zsh' }, 'linux'), 'zsh');
  assert.equal(completion.detectShell({}, 'win32'), 'powershell');

  const home = mkdtempSync(join(tmpdir(), 'crpc-comp-'));
  writeFileSync(join(home, '.zshrc'), 'export A=1\n');
  const opts = { configDir: join(home, 'cfg'), home, env: {}, platform: 'linux' };
  const r = completion.install('zsh', opts);
  assert.ok(r.changed && existsSync(r.script));
  assert.ok(completion.isInstalled('zsh', opts));
  assert.equal(completion.install('zsh', opts).changed, false);
  completion.install('fish', opts);
  assert.ok(existsSync(join(home, '.config', 'fish', 'completions', 'claude-rpc.fish')));
  completion.uninstall(opts);
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), 'export A=1\n');
  assert.ok(!completion.isInstalled('zsh', opts) && !completion.isInstalled('fish', opts));
  assert.equal(completion.targets('bash', { ...opts, platform: 'darwin' }).rc, join(home, '.bash_profile'));
});

test('statcards: arg parsing', () => {
  assert.deepEqual(
    { ...parseArgs(['badge', '--metric', 'streak', '--png', 'out.png']) },
    { card: 'badge', out: 'png', path: 'out.png', md: false, html: false, copy: false, metric: 'streak', range: null, year: null });
  assert.equal(parseArgs(['--png', 'stats']).path, null, 'a card name after --png is the card, not a path');
  assert.equal(parseArgs(['--png', 'stats']).card, 'stats');
  assert.equal(parseArgs(['stats', '--svg=x.svg']).path, 'x.svg');
  assert.equal(parseArgs(['stats', '--md']).out, 'link');
  assert.ok(parseArgs(['--bogus']).error);
});

test('statcards: live-link snippets', () => {
  const stats = CARDS.find((k) => k.id === 'stats');
  const s = snippets(stats, 'ada', { metric: 'hours' }, 'https://w.example/');
  assert.equal(s.url, 'https://w.example/stats/ada.svg?metric=hours');
  assert.equal(snippets(stats, 'ada', { metric: 'tokens' }, 'https://w.example').url, 'https://w.example/stats/ada.svg');
  assert.equal(s.md, '[![Claude Code stats](https://w.example/stats/ada.svg?metric=hours)](https://claude-rpc.com/u/ada)');
  assert.match(s.html, /^<a href="https:\/\/claude-rpc.com\/u\/ada"><img src="https:\/\/w.example\/stats\/ada.svg\?metric=hours"/);
  const badge = CARDS.find((k) => k.id === 'badge');
  assert.equal(snippets(badge, 'ada', {}, 'https://w.example').url, 'https://w.example/badge/ada.svg?metric=hours');
  // Every card goes somewhere.
  for (const k of CARDS) assert.ok(k.local || k.hosted, k.id);
});

test('png: svg size and renderer argv', () => {
  assert.deepEqual(svgSize('<svg xmlns="x" width="480" height="252">'), { width: 480, height: 252 });
  assert.deepEqual(svgSize('<svg viewBox="0 0 880 540">'), { width: 880, height: 540 });
  const a = rasterArgs('browser', { htmlFile: '/t/c.html', out: '/t/o.png', width: 10, height: 20, scale: 2, profileDir: '/t/p', root: true });
  assert.ok(a.includes('--window-size=10,20') && a.includes('--screenshot=/t/o.png') && a.includes('--no-sandbox'));
  assert.deepEqual(rasterArgs('rsvg', { svgFile: 'i.svg', out: 'o.png', scale: 2 }), ['-z', '2', '-b', 'none', '-o', 'o.png', 'i.svg']);
  assert.equal(findRasterizer({ PATH: '', CLAUDE_RPC_BROWSER: '/definitely/not/here' }, 'linux'), null);
});

// Headless Chrome on shared CI runners hangs now and then; there, only rsvg.
const renderer = findRasterizer();
const pngSkip = !renderer ? 'no SVG renderer here'
  : process.env.CI && renderer.kind === 'browser' ? 'headless browser is flaky on CI runners' : false;
test('png: renders a real PNG when the machine has a renderer', { skip: pngSkip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crpc-png-'));
  const out = join(dir, 'o.png');
  const r = await svgToPng('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#c2491e"/></svg>', out);
  assert.equal(r.width, 80);
  assert.deepEqual([...readFileSync(out).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});
