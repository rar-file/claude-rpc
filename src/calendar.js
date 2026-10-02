// Activity calendar — a GitHub-contributions-style year heatmap of Claude
// Code activity, rendered as an embeddable SVG (paper/terracotta brand).
// `claude-rpc calendar [--metric tokens|hours] [--card] --out cal.svg [--gist]`.
//
// Drawing lives in heatmap.js, shared with the worker's live /heatmap and
// /stats endpoints, so a local render and the live README card look the same.

import { buildDailySeries } from './community.js';
import { renderHeatmap, renderStatsCard } from './heatmap.js';
import { localDateStamp } from './fmt.js';
import { VERSION } from './version.js';

function lifetimeTokens(a) {
  return (a?.inputTokens || 0) + (a?.outputTokens || 0) + (a?.cacheReadTokens || 0) + (a?.cacheWriteTokens || 0);
}

export function renderCalendar(aggregate, { metric = 'hours', generatedAt = new Date() } = {}) {
  const series = buildDailySeries(aggregate, generatedAt.getTime());
  return renderHeatmap({
    series,
    metric,
    footer: `as of ${localDateStamp(generatedAt)} · claude-rpc.com · v${VERSION}`,
  });
}

// Stats card + heatmap from the local aggregate — the offline twin of the
// worker's /stats/<handle>.svg.
export function renderCalendarCard(aggregate, { metric = 'tokens', handle = '', generatedAt = new Date() } = {}) {
  const series = buildDailySeries(aggregate, generatedAt.getTime());
  const h = String(handle || '').replace(/^@/, '');
  const p = {
    handle: h || 'you',
    displayName: h ? null : 'Claude Code',
    verified: false,
    githubUser: null,
    tokens: lifetimeTokens(aggregate),
    sessions: aggregate?.sessions || 0,
    activeMs: aggregate?.activeMs || 0,
    streak: aggregate?.streak || 0,
  };
  return renderStatsCard(p, series, {
    metric,
    kicker: h ? 'Claude Code' : 'my year',
    footer: `as of ${localDateStamp(generatedAt)} · v${VERSION}`,
  });
}

export function calendarSvg({ aggregate } = {}) {
  return renderCalendar(aggregate, {});
}
