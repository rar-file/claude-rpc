#!/usr/bin/env node
// Local web dashboard for Claude RPC.
//
// Split layout (since the v0.4 refactor):
//   server/index.js   — this file: HTTP lifecycle, request dispatch, SIGINT
//   server/api.js     — data helpers (snapshot, windowedAggregate, drilldowns)
//   server/routes.js  — declarative /api/* route table
//   server/sse.js     — SSE broadcast + file watchers
//   server/page.js    — composes the dashboard + /wrapped pages from the
//                       on-disk files in server/assets/ (via assets.js)
//
// Zero deps, vanilla browser JS, SVG charts. Designed to run alongside the
// daemon on localhost:47474 so the user can poke at their own data.

import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { ROUTES, JSON_HEADERS } from './routes.js';
import { projectDrilldown, dayDetail } from './api.js';
import { watchSources, addClient, removeClient } from './sse.js';
import { buildHtml, buildWrappedHtml, buildSettingsHtml } from './page.js';
import { writeAllowed } from './settings.js';

const PORT = Number(process.env.CLAUDE_RPC_PORT) || 47474;

// Pre-compose the HTML once at startup — the only dynamic bit is the port
// (shown in the footer), which is fixed for the life of the process.
const HTML = buildHtml({ port: PORT });
const WRAPPED_HTML = buildWrappedHtml();
const SETTINGS_HTML = buildSettingsHtml({ port: PORT });
const PAGES = new Map([
  ['/', HTML], ['/index.html', HTML],
  ['/settings', SETTINGS_HTML], ['/settings.html', SETTINGS_HTML], // config, daemon, privacy
  ['/wrapped', WRAPPED_HTML], ['/wrapped.html', WRAPPED_HTML], // animated year-in-review
]);

// Path-prefix drilldowns — the project name / day key is in the URL path
// itself, not in a query string.
const DRILLDOWNS = [['/api/project/', projectDrilldown], ['/api/day/', dayDetail]];

function parseUrl(rawUrl) {
  const url = new URL(rawUrl, 'http://x');
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}

// Loopback-only Host allowlist. Binding to 127.0.0.1 blocks the LAN, but not
// DNS rebinding: a malicious page can point its own hostname at 127.0.0.1 and
// become "same-origin" with this server, then read /api/export.json. Rejecting
// non-local Host headers closes that — browsers always send the page's host.
function isLocalHost(host) {
  const h = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

function dispatch(req, res) {
  if (!isLocalHost(req.headers.host)) {
    res.writeHead(403, JSON_HEADERS).end(JSON.stringify({ error: 'forbidden' }));
    return;
  }
  const { path, query } = parseUrl(req.url);
  const key = `${req.method} ${path}`;

  // SSE endpoint — client subscribes once, gets pushed updates on file
  // changes (debounced 200ms in sse.js).
  if (req.method === 'GET' && path === '/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
    });
    res.write(': hello\n\n');
    addClient(res);
    req.on('close', () => removeClient(res));
    return;
  }

  for (const [prefix, lookup] of DRILLDOWNS) {
    if (req.method !== 'GET' || !path.startsWith(prefix)) continue;
    const id = safeDecode(path.slice(prefix.length));
    if (id === null) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'bad request' })); return; }
    const result = lookup(id);
    res.writeHead(result ? 200 : 404, JSON_HEADERS);
    res.end(JSON.stringify(result || { error: 'not found' }));
    return;
  }

  // Static /api/* endpoints (state, wrapped, aggregate, insights, badge.svg,
  // card.svg, export.json, export.csv, settings) — see routes.js.
  const handler = ROUTES.get(key);
  if (handler && req.method === 'POST') return handleWrite(req, res, handler, query);
  if (handler) return handler(req, res, { query });

  const page = req.method === 'GET' && PAGES.get(path);
  if (page) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
    return;
  }

  res.writeHead(404).end('not found');
}

const MAX_BODY_BYTES = 512 * 1024;

function handleWrite(req, res, handler, query) {
  const fail = (code, error) => {
    if (!res.headersSent) res.writeHead(code, JSON_HEADERS).end(JSON.stringify({ error }));
  };
  if (!writeAllowed(req.headers)) return fail(403, 'forbidden');
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) { fail(413, 'request too large'); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('error', () => fail(400, 'bad request'));
  req.on('end', async () => {
    if (res.headersSent) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { return fail(400, 'body is not valid JSON'); }
    try { await handler(req, res, { query, body }); }
    catch { fail(500, 'internal error'); }
  });
}

const server = createServer((req, res) => {
  try {
    dispatch(req, res);
  } catch {
    // A malformed aggregate or any thrown handler must not take down the whole
    // in-process dashboard (it runs inside `claude-rpc serve`). Respond 500 if
    // the socket is still writable, else just close it.
    if (!res.headersSent) res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: 'internal error' }));
    else try { res.end(); } catch { /* socket already torn down */ }
  }
});

// Listen failures arrive as an 'error' event. Without a handler the
// uncaughtException floor below swallowed EADDRINUSE and the process then sat
// forever on the poll interval + fs watchers, serving nothing — e.g. a second
// `claude-rpc serve`, or the tray and the Stats tab each spawning one. Say why
// in one line and exit non-zero instead. Once listening, an 'error' is logged
// and the dashboard keeps running (same policy as the floor).
// `claude-rpc wrapped` / `settings` set CLAUDE_RPC_OPEN_PATH to land on that
// page instead of the dashboard.
const OPEN_PATH = process.env.CLAUDE_RPC_OPEN_PATH || '';

function openBrowser(url) {
  if (process.env.CLAUDE_RPC_NO_OPEN) return;
  const opener = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  // windowsHide so the cmd.exe that runs `start` doesn't flash a console.
  exec(opener, { windowsHide: true }, () => {});
}

// Is the thing already on our port a claude-rpc dashboard new enough to have
// the page we want? /api/settings exists on every build that serves /settings.
async function dashboardAlreadyUp(base) {
  try {
    const res = await fetch(`${base}/api/settings`, { signal: AbortSignal.timeout(1500) });
    return res.ok && typeof (await res.json()).version === 'string';
  } catch { return false; }
}

server.on('error', async (e) => {
  if (server.listening) {
    try { console.error('dashboard error:', e?.message || e); } catch { /* ignore */ }
    return;
  }
  const base = `http://127.0.0.1:${PORT}`;
  // A dashboard is already running (another terminal, a previous `serve`):
  // that's not a failure — open the page in it.
  if (e?.code === 'EADDRINUSE' && await dashboardAlreadyUp(base)) {
    console.log(`◆ Claude RPC dashboard is already running: ${base}${OPEN_PATH}`);
    openBrowser(base + OPEN_PATH);
    // Let the opener spawn before exiting.
    setTimeout(() => process.exit(0), 300);
    return;
  }
  console.error(e?.code === 'EADDRINUSE'
    ? `✗ Port ${PORT} is in use by another program or an older claude-rpc dashboard — stop it, or set CLAUDE_RPC_PORT to use another port.`
    : `✗ Dashboard could not listen on 127.0.0.1:${PORT}: ${e?.message || e}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  // Start watching only once the port is ours, so a failed listen exits
  // without leaving watchers behind.
  watchSources();
  const base = `http://127.0.0.1:${PORT}`;
  const url = base + OPEN_PATH;
  console.log(`◆ Claude RPC dashboard: ${base}`);
  console.log(`  ${OPEN_PATH ? 'opening ' + url + '  ·  ' : ''}Ctrl-C to stop.`);
  openBrowser(url);
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Last-resort floor for the async edges the per-request try/catch can't reach
// (SSE writes, timer callbacks). Keeping the localhost dashboard alive beats
// crashing it; the per-request guard above handles the common sync case.
process.on('uncaughtException', (e) => { try { console.error('dashboard error:', e?.message || e); } catch { /* ignore */ } });
process.on('unhandledRejection', (e) => { try { console.error('dashboard rejection:', e?.message || e); } catch { /* ignore */ } });
