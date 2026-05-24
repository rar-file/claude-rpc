// /api/* route table. Each handler reads fresh aggregate/state per request
// (cheap — these files are tiny). Returns a Map indexed by `METHOD PATH`
// — the createServer dispatch in index.js does a lookup + falls back to
// a handful of path-prefix checks (project/, day/) and the SSE / page
// endpoints.

import { readAggregate } from '../scanner.js';
import { generateInsights } from '../insights.js';
import { badgeSvg } from '../badge.js';
import { renderCard } from '../card.js';
import { snapshot, windowedAggregate, aggregateToCsv } from './api.js';

export const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
};

export const ROUTES = new Map();

ROUTES.set('GET /api/state', (req, res) => {
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(snapshot()));
});

ROUTES.set('GET /api/aggregate', (req, res, { query }) => {
  const range = query.range || '90d';
  const agg = readAggregate();
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(windowedAggregate(agg, range)));
});

ROUTES.set('GET /api/insights', (req, res, { query }) => {
  const agg = readAggregate();
  const lines = generateInsights(agg, { limit: parseInt(query.limit, 10) || 5 });
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify({ insights: lines }));
});

ROUTES.set('GET /api/badge.svg', (req, res, { query }) => {
  const agg = readAggregate();
  const svg = badgeSvg({
    aggregate: agg,
    metric: query.metric || 'hours',
    range: query.range || '7d',
    label: query.label,
  });
  res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'max-age=60, public',
  });
  res.end(svg);
});

// Data export. content-disposition: attachment makes the browser download
// rather than render. The JSON is the raw aggregate; the CSV is byDay
// flattened to daily rows (see aggregateToCsv).
ROUTES.set('GET /api/export.json', (req, res) => {
  const agg = readAggregate() || {};
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-disposition': 'attachment; filename="claude-rpc-aggregate.json"',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(agg, null, 2));
});

ROUTES.set('GET /api/export.csv', (req, res) => {
  const agg = readAggregate() || {};
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': 'attachment; filename="claude-rpc-daily.csv"',
    'cache-control': 'no-store',
  });
  res.end(aggregateToCsv(agg));
});

// Poster-style card. `?range=year|month|week|all` (default year).
ROUTES.set('GET /api/card.svg', (req, res, { query }) => {
  const agg = readAggregate();
  const svg = renderCard(agg, { range: query.range || 'year' });
  res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'max-age=60, public',
  });
  res.end(svg);
});
