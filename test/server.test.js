// Server route walker + api helpers. The dashboard's HTTP surface had
// zero direct test coverage before this. A broken windowedAggregate
// shape (the v0.4 split-server-out refactor came close) or an SSE
// handler that throws on a malformed event would be invisible.
//
// Strategy: boot the dashboard on a random high port via the child
// process so module-load side effects (PORT, opener-shellout) are
// real; hit every documented route; assert 200 + content-type +
// parseable JSON or SVG. SSE is excluded — the request never
// terminates by design.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function bootServer(port) {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server', 'index.js')], {
    env: { ...process.env, CLAUDE_RPC_PORT: String(port), CLAUDE_RPC_NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let done = false;
    const onStdout = (b) => {
      if (done) return;
      if (String(b).includes(`${port}`)) { done = true; resolve(child); }
    };
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStdout);
    child.on('error', reject);
    setTimeout(() => { if (!done) { done = true; resolve(child); } }, 1500);
  });
}

async function fetchJson(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, type: r.headers.get('content-type') || '', body: await r.text() };
}

test('server: every documented route returns 200 with sane content', async (t) => {
  // Pick a high port unlikely to clash with anything else.
  const PORT = 47570 + Math.floor(Math.random() * 200);
  const child = await bootServer(PORT);
  t.after(() => child.kill());
  await delay(120); // give listen() a beat

  // GET /api/state — JSON snapshot
  {
    const r = await fetchJson(PORT, '/api/state');
    assert.equal(r.status, 200);
    assert.match(r.type, /application\/json/);
    const data = JSON.parse(r.body);
    assert.ok('state' in data, '/api/state returns a state field');
    assert.ok('aggregate' in data, '/api/state returns an aggregate field');
  }

  // GET /api/aggregate — windowed roll-up
  {
    const r = await fetchJson(PORT, '/api/aggregate?range=7d');
    assert.equal(r.status, 200);
    const data = JSON.parse(r.body);
    // Either a real aggregate or null when no scan exists. Both are valid.
    if (data) assert.ok('byDay' in data || 'activeMs' in data || data === null);
  }

  // GET /api/insights — sorted line array
  {
    const r = await fetchJson(PORT, '/api/insights');
    assert.equal(r.status, 200);
    const data = JSON.parse(r.body);
    assert.ok(Array.isArray(data.insights));
  }

  // GET /api/badge.svg — SVG content
  {
    const r = await fetchJson(PORT, '/api/badge.svg?metric=hours&range=7d');
    assert.equal(r.status, 200);
    assert.match(r.type, /svg/);
    assert.match(r.body, /^<svg/);
  }

  // GET /api/card.svg — SVG content
  {
    const r = await fetchJson(PORT, '/api/card.svg?range=year');
    assert.equal(r.status, 200);
    assert.match(r.type, /svg/);
    assert.match(r.body, /^<svg/);
  }

  // GET / — main HTML page
  {
    const r = await fetchJson(PORT, '/');
    assert.equal(r.status, 200);
    assert.match(r.type, /text\/html/);
    assert.match(r.body, /<!doctype html>/i);
  }

  // GET /api/day/<key> — depends on the test machine having aggregates
  // for that day, so we expect 200 OR 404 (both are well-formed JSON).
  {
    const today = new Date();
    const k = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const r = await fetchJson(PORT, `/api/day/${k}`);
    assert.ok(r.status === 200 || r.status === 404, `expected 200 or 404, got ${r.status}`);
    JSON.parse(r.body);
  }

  // 404 path
  {
    const r = await fetchJson(PORT, '/totally-not-a-route');
    assert.equal(r.status, 404);
  }

  // Malformed percent-encoding must return 400, not crash the server.
  {
    const r = await fetchJson(PORT, '/api/project/%');
    assert.equal(r.status, 400, 'malformed /api/project/% returns 400');
    assert.deepEqual(JSON.parse(r.body), { error: 'bad request' });
  }
  {
    const r = await fetchJson(PORT, '/api/day/%');
    assert.equal(r.status, 400, 'malformed /api/day/% returns 400');
    assert.deepEqual(JSON.parse(r.body), { error: 'bad request' });
  }
  // Verify server is still alive after the bad requests.
  {
    const r = await fetchJson(PORT, '/api/state');
    assert.equal(r.status, 200, 'server still alive after malformed requests');
  }
});

// Direct unit test of the data-shape helpers, separate from the HTTP
// surface — lets a regression in windowedAggregate shape surface
// without booting the server.
test('windowedAggregate trims to range and recomputes roll-ups', async () => {
  const { windowedAggregate } = await import('../src/server/api.js');

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const ago = (n) => {
    const d = new Date(today); d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  const agg = {
    byDay: {
      [ago(0)]:  { activeMs: 3600_000, userMessages: 1, cost: 0.1 },
      [ago(5)]:  { activeMs: 7200_000, userMessages: 2, cost: 0.2 },
      [ago(9)]:  { activeMs: 1800_000 }, // in the prior 7d window (days 7-13)
      [ago(40)]: { activeMs: 5400_000, userMessages: 3, cost: 0.3 },
    },
    streak: 1,
  };
  const win = windowedAggregate(agg, '7d');
  assert.ok(Object.keys(win.byDay).length === 2, 'days outside 7d window dropped');
  assert.equal(win.activeMs, 3600_000 + 7200_000);
  assert.equal(win.userMessages, 3);
  assert.ok(win.estimatedCost > 0);
  assert.equal(win.priorActiveMs, 1800_000, 'prior identical window summed for the range delta');
});

// range=all used to return the raw aggregate, which has no grandTokens, so
// the range + cost cards read "0 tok" on the All pill.
test('windowedAggregate range=all keeps the lifetime aggregate and adds grandTokens', async () => {
  const { windowedAggregate } = await import('../src/server/api.js');
  const agg = {
    byDay: { '2020-01-01': { activeMs: 1 } },
    inputTokens: 10, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 4000,
    estimatedCost: 1.25, sessions: 7,
  };
  const all = windowedAggregate(agg, 'all');
  assert.equal(all.grandTokens, 4330);
  assert.equal(all.sessions, 7, 'lifetime fields pass through');
  assert.deepEqual(all.byDay, agg.byDay, 'full history, not windowed');
  assert.equal(agg.grandTokens, undefined, 'input aggregate not mutated');
  assert.equal(windowedAggregate(null, 'all'), null);
});

// The web "Discord presence" panel used to render the legacy top-level
// presence.rotation, which the default config doesn't have (→ zero frames),
// while the daemon renders presence.byStatus. presenceFrames must preview the
// same frames the daemon picks, with the daemon's first-tick frame on air.
test('presenceFrames previews the byStatus frames the daemon renders', async () => {
  const { presenceFrames } = await import('../src/server/api.js');
  const { DEFAULT_CONFIG } = await import('../src/default-config.js');
  const { pickFrames, selectFrame, makeRotationCursor } = await import('../src/presence.js');
  const { buildVars, fillTemplate, framePasses } = await import('../src/format.js');
  const now = Date.now();
  const state = {
    status: 'working', cwd: '/home/u/projects/my-app', model: 'claude-opus-5-5',
    sessionStart: now - 30 * 60_000, lastActivity: now, messages: 3, tools: 5,
    currentTool: 'Edit', currentFile: '/home/u/projects/my-app/src/a.js',
    tokens: { input: 100, output: 200, cacheRead: 3000, cacheWrite: 40 },
    filesOpened: [], filesEdited: [], filesRead: [], toolBreakdown: {},
  };
  const vars = buildVars(state, DEFAULT_CONFIG, {});
  const p = DEFAULT_CONFIG.presence;
  assert.ok(Object.keys(p.byStatus).length > 0, 'default config drives the card from byStatus');
  for (const status of Object.keys(p.byStatus)) {
    const raw = pickFrames(p, status).frames;
    const frames = presenceFrames(p, { status }, vars);
    assert.equal(frames.length, raw.length, `${status}: one preview frame per card frame`);
    assert.ok(frames.length > 0, `${status}: preview is not empty`);
    const daemonFirst = selectFrame(raw, vars, status, makeRotationCursor(), 12_000, framePasses, now);
    const onAir = frames.find((f) => f.passes);
    assert.equal(onAir.details, fillTemplate(daemonFirst.details || '', vars).slice(0, 128), `${status}: on-air details`);
    assert.equal(onAir.state, fillTemplate(daemonFirst.state || '', vars).slice(0, 128), `${status}: on-air state`);
  }
  const legacy = { ...p, rotation: [{ details: 'LEGACY ROTATION' }] };
  assert.ok(
    !presenceFrames(legacy, { status: 'idle' }, vars).some((f) => f.details === 'LEGACY ROTATION'),
    'a stray legacy rotation is not what the card shows when byStatus covers the status',
  );
  const trig = presenceFrames(p, { status: 'trigger', _triggerFrame: { details: 'Testing {project}' } }, vars);
  assert.deepEqual(trig.map((f) => f.details), [fillTemplate('Testing {project}', vars)], 'trigger overlay frame');
  const gated = presenceFrames({ byStatus: { idle: { details: 'Base', rotation: [{ details: 'x', requires: 'noSuchVar' }] } } }, { status: 'idle' }, vars);
  assert.deepEqual(gated.map((f) => f.passes), [true, false], 'requires-gated frames are marked, base stays on air');
  const none = presenceFrames({ byStatus: { idle: { details: 'Only', requires: 'noSuchVar' } } }, { status: 'idle' }, vars);
  assert.equal(none[0].passes, true, 'like selectFrame, the base frame airs when nothing passes');
});

test('rangeToDays parses range tokens', async () => {
  const { rangeToDays } = await import('../src/server/api.js');
  assert.equal(rangeToDays('7d'), 7);
  assert.equal(rangeToDays('30d'), 30);
  assert.equal(rangeToDays('1y'), 365);
  assert.equal(rangeToDays('all'), Infinity);
  assert.equal(rangeToDays(undefined), 90, 'default 90d window');
  assert.ok(rangeToDays('99999999') <= 366, 'huge ranges clamp so windowedAggregate cannot spin');
});

test('buildHtml interpolates port', async () => {
  const { buildHtml } = await import('../src/server/page.js');
  const html = buildHtml({ port: 12345 });
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('12345'), 'port appears in the footer');
});

test('aggregateToCsv flattens byDay into sorted daily rows', async () => {
  const { aggregateToCsv, CSV_COLUMNS } = await import('../src/server/api.js');
  const csv = aggregateToCsv({
    byDay: {
      '2026-01-02': { activeMs: 3_600_000, sessions: 1, userMessages: 5, cost: 0.5 },
      '2026-01-01': { activeMs: 7_200_000, sessions: 2, linesAdded: 100 },
    },
  });
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], CSV_COLUMNS.join(','), 'header row matches column list');
  assert.ok(lines[1].startsWith('2026-01-01,'), 'rows sorted ascending by date');
  assert.ok(lines[2].startsWith('2026-01-02,'));
  assert.match(lines[1], /,2\.000,/, '7.2M ms → 2.000 activeHours');
});

test('aggregateToCsv handles empty / missing byDay', async () => {
  const { aggregateToCsv, CSV_COLUMNS } = await import('../src/server/api.js');
  assert.equal(aggregateToCsv({}).trim(), CSV_COLUMNS.join(','), 'header only when empty');
  assert.equal(aggregateToCsv(null).trim(), CSV_COLUMNS.join(','), 'null-safe');
});
