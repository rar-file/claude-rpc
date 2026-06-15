// Shields-style SVG badge generator. Pure function: aggregate + flags → SVG string.
// Consumed by `claude-rpc badge` and `GET /api/badge.svg`.

import { dayKey } from './scanner.js';
import { fmtCost } from './pricing.js';
import { fmtNum, fmtHours as fmtHoursLabel } from './fmt.js';

const COLORS = {
  hours:  { left: '#555', right: '#4c1' },     // green
  streak: { left: '#555', right: '#fe7d37' },  // orange
  cost:   { left: '#555', right: '#3a7' },     // teal-green
  lines:  { left: '#555', right: '#08c' },     // blue
  prompts:{ left: '#555', right: '#5865F2' },  // discord blurple
  tokens: { left: '#555', right: '#a55' },     // dim red
  files:  { left: '#555', right: '#aa6' },     // olive
};

// Resolve a range token to a count of days back from today.
//   'all'                → entire history
//   'year' / 'y'         → 365 days
//   'month' / 'mo' / 'm' → 30 days
//   'week' / 'w'         → 7 days
//   numeric ('30d', '7') → that many days
function rangeToDays(range) {
  if (!range || range === 'all') return null;             // null = unbounded
  if (/^(year|1y|y|365d?)$/i.test(range)) return 365;
  if (/^(month|1mo|mo|m|30d?)$/i.test(range)) return 30;
  if (/^(week|1w|w|7d?)$/i.test(range)) return 7;
  if (/^(day|1d|d|24h|today)$/i.test(range)) return 1;
  const n = parseInt(range, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function pickWindow(byDay, range) {
  if (!byDay) return [];
  const days = rangeToDays(range);
  if (days === null) return Object.entries(byDay);          // 'all'
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const k = dayKey(d.getTime());
    if (byDay[k]) out.push([k, byDay[k]]);
  }
  return out;
}

// Pretty label for a range — used as badge subtitle.
//   'year' → 'year'   '30' → '30d'   'all' → 'all-time'
function rangeLabel(range) {
  if (!range || range === 'all') return 'all-time';
  if (/^(year|1y|y|365d?)$/i.test(range)) return 'year';
  if (/^(month|1mo|mo|m|30d?)$/i.test(range)) return 'month';
  if (/^(week|1w|w|7d?)$/i.test(range)) return 'week';
  if (/^(day|1d|d|24h|today)$/i.test(range)) return 'today';
  const n = parseInt(range, 10);
  return Number.isFinite(n) && n > 0 ? `${n}d` : range;
}

export { rangeToDays, rangeLabel, pickWindow };

// Compute label/value pair for the requested metric.
function valueFor(aggregate, metric, range) {
  const a = aggregate || {};
  const window = pickWindow(a.byDay, range);
  const rl = rangeLabel(range);

  switch (metric) {
    case 'hours': {
      const ms = window.reduce((s, [, d]) => s + (d.activeMs || 0), 0);
      return { label: `claude · ${rl}`, value: fmtHoursLabel(ms) };
    }
    case 'streak': {
      return { label: 'streak', value: `${a.streak || 0} days` };
    }
    case 'cost': {
      const cost = window.reduce((s, [, d]) => s + (d.cost || 0), 0);
      return { label: `claude cost · ${rl}`, value: fmtCost(cost) };
    }
    case 'lines': {
      const lines = window.reduce((s, [, d]) => s + (d.linesAdded || 0), 0);
      return { label: `lines · ${rl}`, value: fmtNum(lines) };
    }
    case 'prompts': {
      const p = window.reduce((s, [, d]) => s + (d.userMessages || 0), 0);
      return { label: `prompts · ${rl}`, value: fmtNum(p) };
    }
    case 'tokens': {
      const t = window.reduce((s, [, d]) =>
        s + (d.inputTokens || 0) + (d.outputTokens || 0)
        + (d.cacheReadTokens || 0) + (d.cacheWriteTokens || 0), 0);
      return { label: `tokens · ${rl}`, value: fmtNum(t) };
    }
    case 'files': {
      return { label: 'files touched', value: fmtNum(a.uniqueFiles || 0) };
    }
    default:
      return { label: metric, value: '—' };
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Approximate text width in pixels for Verdana 11px. Good enough for badges.
// Widens slightly to compensate for variable-width glyphs.
function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    if (/[il1.\s]/.test(ch)) w += 4;
    else if (/[A-Z]/.test(ch)) w += 8;
    else w += 6.5;
  }
  return Math.ceil(w);
}

export function renderBadge({ label, value, color }) {
  const PAD = 8;
  const labelW = textWidth(label) + PAD * 2;
  const valueW = textWidth(value) + PAD * 2;
  const total = labelW + valueW;
  const leftColor = color?.left || '#555';
  const rightColor = color?.right || '#4c1';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">
  <title>${escapeXml(label)}: ${escapeXml(value)}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="${leftColor}"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${rightColor}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">
    <text aria-hidden="true" x="${(labelW * 10) / 2}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(labelW - PAD * 2) * 10}">${escapeXml(label)}</text>
    <text x="${(labelW * 10) / 2}" y="140" transform="scale(.1)" fill="#fff" textLength="${(labelW - PAD * 2) * 10}">${escapeXml(label)}</text>
    <text aria-hidden="true" x="${(labelW + valueW / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(valueW - PAD * 2) * 10}">${escapeXml(value)}</text>
    <text x="${(labelW + valueW / 2) * 10}" y="140" transform="scale(.1)" fill="#fff" textLength="${(valueW - PAD * 2) * 10}">${escapeXml(value)}</text>
  </g>
</svg>`;
}

// Top-level convenience: aggregate + flags → SVG string.
export function badgeSvg({ aggregate, metric = 'hours', range = '7d', label, color }) {
  const v = valueFor(aggregate, metric, range);
  const finalLabel = label ?? v.label;
  const finalColor = color ?? COLORS[metric] ?? COLORS.hours;
  return renderBadge({ label: finalLabel, value: v.value, color: finalColor });
}
