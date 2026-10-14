// End-to-end checks for `claude-rpc serve` against a sandboxed HOME/TMPDIR
// holding the files real hooks + the scanner write: a per-session
// state-<sid>.json (no legacy state.json) and an aggregate whose history runs
// past every range pill. Covers the bugs where the dashboard read only the
// legacy state.json, previewed the wrong presence frames, had no large image,
// answered "No activity" for days outside the range, presented global data as
// per-project, and hung forever when its port was taken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { loadConfig } from '../src/config.js';
import { pickFrames, resolveLargeImageKey } from '../src/presence.js';
import { fillTemplate } from '../src/format.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'sess-live-1';

const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function ago(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return dayKey(d);
}

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), 'crpc-serve-'));
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  const stateDir = join(tmp, 'claude-rpc');
  mkdirSync(join(home, '.claude-rpc'), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const day = (h) => ({
    activeMs: h * 3_600_000,
    userMessages: 3,
    sessions: 1,
    inputTokens: 10,
    outputTokens: 20,
  });
  writeFileSync(
    join(home, '.claude-rpc', 'aggregate.json'),
    JSON.stringify({
      sessions: 2,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 3000,
      cacheWriteTokens: 40,
      byDay: { [ago(0)]: day(1), [ago(400)]: day(5) },
      projects: {
        'my-app': { sessions: 2, activeMs: 6 * 3_600_000, userMessages: 6, toolCalls: 9 },
      },
      topEditedFiles: [{ path: '/elsewhere/other-project/global.js', count: 9 }],
      toolBreakdown: { Edit: 9 },
    }),
  );
  writeState(stateDir, { status: 'working' });
  return { root, home, tmp, stateDir };
}

function writeState(stateDir, over) {
  const now = Date.now();
  const p = join(stateDir, `state-${SID}.json`);
  const body = {
    sessionStart: now - 10 * 60_000,
    lastActivity: now,
    status: 'working',
    currentTool: 'Edit',
    currentFile: 'a.js',
    model: 'claude-opus-5-5',
    cwd: join(tmpdir(), 'my-app'),
    messages: 2,
    tools: 3,
    claudeClosed: false,
    ...over,
  };
  writeFileSync(`${p}.${process.pid}.tmp`, JSON.stringify(body));
  renameSync(`${p}.${process.pid}.tmp`, p);
}

function boot(port, sb) {
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server', 'index.js')], {
    env: {
      ...process.env,
      HOME: sb.home,
      USERPROFILE: sb.home,
      TMPDIR: sb.tmp,
      TMP: sb.tmp,
      TEMP: sb.tmp,
      XDG_CONFIG_HOME: join(sb.home, '.config'),
      CLAUDE_RPC_PORT: String(port),
      CLAUDE_RPC_NO_OPEN: '1',
      CLAUDE_RPC_NO_AUTOSTART: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.out = '';
  child.stdout.on('data', (b) => (child.out += b));
  child.stderr.on('data', (b) => (child.out += b));
  child.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return child;
}

async function waitFor(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await delay(25);
  }
  return pred();
}

async function getJson(port, path) {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: r.status, body: await r.json() };
}

test('serve: live data comes from per-session state files and matches the card', async (t) => {
  const PORT = 47993;
  const sb = makeSandbox();
  t.after(() => rmSync(sb.root, { recursive: true, force: true }));
  const child = boot(PORT, sb);
  t.after(() => child.kill());
  assert.ok(await waitFor(() => child.out.includes(String(PORT))), `server booted: ${child.out}`);

  // /api/state reads the hook's state-<sid>.json.
  const { body: snap } = await getJson(PORT, '/api/state');
  assert.equal(snap.state.sessionId, SID);
  assert.equal(snap.state.status, 'working');

  // Presence preview = the frames the daemon renders for this status.
  const cfg = loadConfig();
  const p = cfg.presence || {};
  const raw = pickFrames(p, snap.state.status).frames;
  assert.ok(snap.frames.length > 0, 'presence preview is not empty with the default config');
  assert.equal(snap.frames.length, raw.length);
  assert.equal(snap.frames[0].details, fillTemplate(raw[0].details || '', snap.vars).slice(0, 128));

  // Large image = the card's, same precedence + templating as the daemon.
  const tpl = resolveLargeImageKey(cfg, p, snap.state.status, snap.state.model);
  assert.equal(snap.largeImage, tpl ? fillTemplate(tpl, snap.vars) : null);

  // A day outside every range pill (and the 90d heatmap) still resolves.
  {
    const r = await getJson(PORT, `/api/day/${ago(400)}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.day, ago(400));
    assert.equal(r.body.activeMs, 5 * 3_600_000);
  }
  for (const missing of [ago(1), 'constructor', '__proto__']) {
    const r = await getJson(PORT, `/api/day/${missing}`);
    assert.equal(r.status, 404, `/api/day/${missing}`);
  }

  // Project drilldown carries only that project's own roll-up — no global
  // files/tools masquerading as per-project.
  {
    const r = await getJson(PORT, '/api/project/my-app');
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'my-app');
    assert.equal(r.body.activeMs, 6 * 3_600_000);
    assert.ok(!('files' in r.body) && !('tools' in r.body), 'no global files/tools');
    assert.equal((await getJson(PORT, '/api/project/constructor')).status, 404);
  }

  // range=all carries the token total the range/cost cards read.
  assert.equal((await getJson(PORT, '/api/aggregate?range=all')).body.grandTokens, 3340);

  // SSE: a hook rewriting state-<sid>.json reaches connected browsers.
  if (process.platform !== 'win32') {
    const ac = new AbortController();
    t.after(() => ac.abort());
    const res = await fetch(`http://127.0.0.1:${PORT}/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value);
        }
      } catch {
        /* aborted */
      }
    })();
    assert.ok(await waitFor(() => buf.includes(': hello')), 'SSE connected');
    writeState(sb.stateDir, { status: 'thinking' });
    assert.ok(
      await waitFor(() => buf.includes('"type":"state"')),
      `state frame pushed (got ${JSON.stringify(buf)})`,
    );
    ac.abort();
    await pump;
    assert.equal((await getJson(PORT, '/api/state')).body.state.status, 'thinking');
  }
});

test('serve: a second instance on a busy port exits 1 with a clear message', async (t) => {
  const PORT = 47994;
  const sb = makeSandbox();
  t.after(() => rmSync(sb.root, { recursive: true, force: true }));
  const first = boot(PORT, sb);
  t.after(() => first.kill());
  assert.ok(
    await waitFor(() => first.out.includes(String(PORT))),
    `first instance up: ${first.out}`,
  );

  const second = boot(PORT, sb);
  t.after(() => second.kill());
  const code = await Promise.race([second.exited, delay(5000).then(() => 'still running')]);
  assert.equal(code, 1, `second instance must exit 1, not hang (output: ${second.out})`);
  assert.match(second.out, /already in use/);
  assert.ok(second.out.includes(`http://127.0.0.1:${PORT}`), 'points at the running dashboard');
  assert.equal(second.out.trim().split('\n').length, 1, 'one line');
  assert.equal((await getJson(PORT, '/api/state')).status, 200, 'first instance unaffected');
});
