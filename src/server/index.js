#!/usr/bin/env node
// Local web dashboard for Claude RPC.
//
// Split layout (since the v0.4 refactor):
//   server/index.js   — this file: HTTP lifecycle, request dispatch, SIGINT
//   server/api.js     — data helpers (snapshot, windowedAggregate, drilldowns)
//   server/routes.js  — declarative /api/* route table
//   server/sse.js     — SSE broadcast + file watchers
//   server/page.js    — all browser-side assets (HTML/CSS/JS strings)
//
// Zero deps, vanilla browser JS, SVG charts. Designed to run alongside the
// daemon on localhost:47474 so the user can poke at their own data.

import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { ROUTES, JSON_HEADERS } from './routes.js';
import { projectDrilldown, dayDetail } from './api.js';
import { sseClients, watchSources } from './sse.js';
import { buildHtml, buildWrappedHtml } from './page.js';

// Pre-compose the HTML once at startup — the only dynamic bit is the port
// (used in a breadcrumb), which is fixed for the life of the daemon.
const HTML = buildHtml({ port: Number(process.env.CLAUDE_RPC_PORT) || 47474 });
const WRAPPED_HTML = buildWrappedHtml();

const PORT = Number(process.env.CLAUDE_RPC_PORT) || 47474;

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

const server = createServer((req, res) => {
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
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Project drilldown. Path-prefix dispatch (the project name is in the
  // URL itself, not in a query string).
  if (req.method === 'GET' && path.startsWith('/api/project/')) {
    const name = safeDecode(path.slice('/api/project/'.length));
    if (name === null) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'bad request' })); return; }
    const result = projectDrilldown(name);
    res.writeHead(result ? 200 : 404, JSON_HEADERS);
    res.end(JSON.stringify(result || { error: 'not found' }));
    return;
  }

  // Day detail. Same pattern — day key in the URL path.
  if (req.method === 'GET' && path.startsWith('/api/day/')) {
    const day = safeDecode(path.slice('/api/day/'.length));
    if (day === null) { res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: 'bad request' })); return; }
    const result = dayDetail(day);
    res.writeHead(result ? 200 : 404, JSON_HEADERS);
    res.end(JSON.stringify(result || { error: 'not found' }));
    return;
  }

  // Static /api/* endpoints (state, aggregate, insights, badge.svg, card.svg).
  const handler = ROUTES.get(key);
  if (handler) return handler(req, res, { query });

  // Animated year-in-review.
  if (req.method === 'GET' && (path === '/wrapped' || path === '/wrapped.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(WRAPPED_HTML);
    return;
  }

  // Page.
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(HTML);
    return;
  }

  res.writeHead(404).end('not found');
});

watchSources();

server.listen(PORT, '127.0.0.1', () => {
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
    exec(opener, () => {});
  }
});

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
