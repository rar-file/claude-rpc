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
import { buildHtml, buildWrappedHtml } from './page.js';

const PORT = Number(process.env.CLAUDE_RPC_PORT) || 47474;

// Pre-compose the HTML once at startup — the only dynamic bit is the port
// (shown in the footer), which is fixed for the life of the process.
const HTML = buildHtml({ port: PORT });
const WRAPPED_HTML = buildWrappedHtml();
const PAGES = new Map([
  ['/', HTML], ['/index.html', HTML],
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
  // card.svg, export.json, export.csv) — see routes.js.
  const handler = ROUTES.get(key);
  if (handler) return handler(req, res, { query });

  const page = req.method === 'GET' && PAGES.get(path);
  if (page) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
    return;
  }

  res.writeHead(404).end('not found');
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
server.on('error', (e) => {
  if (server.listening) {
    try { console.error('dashboard error:', e?.message || e); } catch { /* ignore */ }
    return;
  }
  const base = `http://127.0.0.1:${PORT}`;
  console.error(e?.code === 'EADDRINUSE'
    ? `✗ Port ${PORT} is already in use — a dashboard may already be running at ${base} (set CLAUDE_RPC_PORT to use another port).`
    : `✗ Dashboard could not listen on 127.0.0.1:${PORT}: ${e?.message || e}`);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  // Start watching only once the port is ours, so a failed listen exits
  // without leaving watchers behind.
  watchSources();
  const base = `http://127.0.0.1:${PORT}`;
  // `claude-rpc wrapped` sets CLAUDE_RPC_OPEN_PATH=/wrapped to land on the
  // animated year-in-review instead of the dashboard.
  const openPath = process.env.CLAUDE_RPC_OPEN_PATH || '';
  const url = base + openPath;
  console.log(`◆ Claude RPC dashboard: ${base}`);
  console.log(`  ${openPath ? 'opening ' + url + '  ·  ' : ''}Ctrl-C to stop.`);
  if (!process.env.CLAUDE_RPC_NO_OPEN) {
    const opener = process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    // windowsHide so the cmd.exe that runs `start` doesn't flash a console.
    exec(opener, { windowsHide: true }, () => {});
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

// Last-resort floor for the async edges the per-request try/catch can't reach
// (SSE writes, timer callbacks). Keeping the localhost dashboard alive beats
// crashing it; the per-request guard above handles the common sync case.
process.on('uncaughtException', (e) => { try { console.error('dashboard error:', e?.message || e); } catch { /* ignore */ } });
process.on('unhandledRejection', (e) => { try { console.error('dashboard rejection:', e?.message || e); } catch { /* ignore */ } });
