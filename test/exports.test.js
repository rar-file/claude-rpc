// Coverage for public exports that were previously exercised only indirectly
// or not at all: the MCP stdio transport (runMcpServer), the SVG entry-point
// wrappers (calendarSvg/cardSvg/sessionCardSvg), the side-effecting notify
// helpers (postWebhook/desktopNotify), and runDoctor's exit-code contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

const { runMcpServer, toolList } = await import('../src/mcp.js');
const { calendarSvg } = await import('../src/calendar.js');
const { cardSvg } = await import('../src/card.js');
const { sessionCardSvg } = await import('../src/session-card.js');
const { postWebhook, desktopNotify, sanitizeLabel } = await import('../src/notify.js');
const { runDoctor, fixPlan, classifyClientId, ipcStateFromLog } = await import('../src/doctor.js');

const fakeAgg = {
  activeMs: 100 * 3_600_000,
  sessions: 50,
  userMessages: 1000,
  inputTokens: 1_000_000,
  outputTokens: 200_000,
  cacheReadTokens: 500_000,
  cacheWriteTokens: 50_000,
  linesAdded: 24_000,
  linesRemoved: 6_000,
  estimatedCost: 89.42,
  streak: 23,
  longestStreak: 30,
  daysSinceFirst: 53,
  topEditedFiles: [{ path: 'src/scanner.js', count: 32 }],
  languages: { JavaScript: { edits: 200, files: 12 } },
  byDay: {
    '2026-05-22': { activeMs: 4 * 3_600_000, userMessages: 18, linesAdded: 320, cost: 1.23, inputTokens: 12000, outputTokens: 6000, cacheReadTokens: 4000, cacheWriteTokens: 0, sessions: 1 },
  },
  byWeekday: { 1: { activeMs: 12 * 3_600_000 } },
  peakHour: { hour: 14, activeMs: 20 * 3_600_000 },
};

// ── runMcpServer (stdio JSON-RPC transport) ───────────────────────────
// Drive it with an in-memory PassThrough. We deliberately never end() the
// input stream — runMcpServer calls process.exit(0) on 'end'.
test('runMcpServer: handles initialize / tools.list / ping / unknown / tools.call', async () => {
  const input = new PassThrough();
  let out = '';
  const output = { write: (s) => { out += s; } };
  runMcpServer({ input, output });

  const reqs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'ping' },
    { jsonrpc: '2.0', id: 4, method: 'totally/bogus' },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_today' } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'no_such_tool' } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} }, // missing name
    { jsonrpc: '2.0', method: 'notifications/initialized' }, // notification: no reply
  ];
  for (const r of reqs) input.write(JSON.stringify(r) + '\n');
  await new Promise((r) => setTimeout(r, 60));

  const byId = Object.fromEntries(
    out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((m) => [m.id, m]),
  );
  assert.equal(byId[1].result.serverInfo.name, 'claude-rpc');
  assert.equal(byId[1].result.protocolVersion, '2024-11-05');
  assert.equal(byId[2].result.tools.length, toolList().length);
  assert.ok(byId[2].result.tools.length > 0);
  assert.deepEqual(byId[3].result, {});
  assert.equal(byId[4].error.code, -32601);
  // tools/call always replies with a content array (isError true OR false).
  assert.ok(Array.isArray(byId[5].result.content));
  // Unknown / missing tool name is a JSON-RPC error (-32602), NOT a tool that
  // ran and failed (which would be an isError content result).
  assert.equal(byId[6].error.code, -32602);
  assert.ok(!byId[6].result, 'unknown tool returns no result');
  assert.equal(byId[7].error.code, -32602);
  // Notifications get no reply, so no message carries id === undefined.
  assert.ok(!('undefined' in byId));

  input.destroy(); // emits 'close', not 'end' — won't trip the exit handler
});

// ── SVG entry-point wrappers ──────────────────────────────────────────
test('calendarSvg / cardSvg / sessionCardSvg delegate and return SVG markup', () => {
  const cal = calendarSvg({ aggregate: fakeAgg });
  assert.ok(cal.includes('<svg'), 'calendarSvg returns svg');

  const card = cardSvg({ aggregate: fakeAgg, range: 'month' });
  assert.ok(card.includes('<svg'), 'cardSvg returns svg');
  assert.ok(card.includes('month on claude'), 'cardSvg honors range');

  const sc = sessionCardSvg({ vars: { project: 'claude-rpc', todayHours: '2.5h' } });
  assert.ok(sc.includes('<svg'), 'sessionCardSvg returns svg');
});

test('SVG wrappers tolerate an empty/absent payload without throwing', () => {
  assert.doesNotThrow(() => cardSvg({ aggregate: {}, range: 'year' }));
  assert.doesNotThrow(() => calendarSvg({ aggregate: {} }));
  assert.doesNotThrow(() => sessionCardSvg({}));
});

// ── notify side-effects ───────────────────────────────────────────────
test('postWebhook: POSTs JSON to the url, swallows rejections, never throws', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push({ url, opts });
    return Promise.reject(new Error('network down')); // must be swallowed
  };
  try {
    assert.doesNotThrow(() => postWebhook('https://example.test/hook', { status: 'working' }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://example.test/hook');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { status: 'working' });
    // No url → no call.
    postWebhook('', { a: 1 });
    assert.equal(calls.length, 1);
    await new Promise((r) => setImmediate(r)); // let the rejected promise settle
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('desktopNotify: spawns the platform notifier with title/body and swallows errors', () => {
  // Inject a recording spawn so the test never fires a real OS toast (it used
  // to on every `npm test`), and assert the load-bearing argv + error listener.
  const calls = [];
  let errorListener = false;
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { on(ev) { if (ev === 'error') errorListener = true; }, unref() {} };
  };
  const result = desktopNotify('claude-rpc', 'test body', { spawn: fakeSpawn });
  assert.equal(result, true);
  assert.equal(calls.length, 1, 'spawned exactly one notifier');
  assert.ok(errorListener, 'attaches a no-op error listener so a missing binary cannot crash the daemon');
  const argv = JSON.stringify(calls[0].args);
  assert.ok(argv.includes('claude-rpc') && argv.includes('test body'), 'title + body reach the notifier');
  // Never throws, even if spawn itself blows up.
  assert.doesNotThrow(() => desktopNotify('x', 'y', { spawn: () => { throw new Error('boom'); } }));
});

test('sanitizeLabel: strips shell/PowerShell metacharacters, keeps readable text', () => {
  // The injection vector: a project dir named to trigger PowerShell evaluation.
  assert.equal(sanitizeLabel('proj$(calc.exe)'), 'projcalc.exe');
  assert.equal(sanitizeLabel('a`whoami`b'), 'awhoamib');
  assert.equal(sanitizeLabel('x"; rm -rf /'), 'x rm -rf ');
  // Benign names — including unicode — survive intact.
  assert.equal(sanitizeLabel('my-project_v2.0'), 'my-project_v2.0');
  assert.equal(sanitizeLabel('café'), 'café');
  assert.equal(sanitizeLabel(null), '');
});

// ── runDoctor ─────────────────────────────────────────────────────────
test('runDoctor: runs the full checklist and returns a 0|1 exit code', () => {
  const realLog = console.log;
  console.log = () => {}; // silence the checklist output during the test
  try {
    const code = runDoctor();
    assert.ok(code === 0 || code === 1, 'returns a documented exit code');
    // fixPlan reflects the run just performed: a deduped, ordered subset of the
    // known repair kinds (used by `doctor --fix`).
    const plan = fixPlan();
    assert.ok(Array.isArray(plan));
    const allowed = ['setup', 'rescan', 'daemon', 'discord'];
    assert.ok(plan.every((k) => allowed.includes(k)), 'only known fix kinds');
    assert.equal(new Set(plan).size, plan.length, 'deduped');
  } finally {
    console.log = realLog;
  }
});

test('classifyClientId: unset / placeholder / malformed / ok', () => {
  assert.equal(classifyClientId(''), 'unset');
  assert.equal(classifyClientId(null), 'unset');
  assert.equal(classifyClientId('1234567890123456789'), 'unset', 'the seed placeholder is not configured');
  assert.equal(classifyClientId('12345'), 'malformed', 'too short for a snowflake');
  assert.equal(classifyClientId('15064abc09406920948'), 'malformed', 'non-digits');
  assert.equal(classifyClientId('1506443909406920948'), 'ok');
});

test('ipcStateFromLog: most-recent line wins (up / down / unknown)', () => {
  assert.equal(ipcStateFromLog(''), 'unknown');
  assert.equal(ipcStateFromLog('Discord RPC connected as foo'), 'up');
  assert.equal(ipcStateFromLog('Presence updated'), 'up');
  assert.equal(ipcStateFromLog('Discord disconnected — retry in 5s'), 'down');
  assert.equal(ipcStateFromLog(['login failed', 'Discord RPC connected'].join('\n')), 'up', 'reconnect after drop → up');
  assert.equal(ipcStateFromLog(['Discord RPC connected', 'retry in 10s'].join('\n')), 'down', 'drop after connect → down');
});
