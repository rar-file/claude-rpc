// Shields-style SVG badge generator. Pure function: aggregate + flags → SVG string.
// Consumed by `claude-rpc badge` and `GET /api/badge.svg`.

import { dayKey } from './scanner.js';
import { fmtCost } from './pricing.js';

const COLORS = {
  hours:  { left: '#555', right: '#4c1' },     // green
  streak: { left: '#555', right: '#fe7d37' },  // orange
  cost:   { left: '#555', right: '#3a7' },     // teal-green
  lines:  { left: '#555', right: '#08c' },     // blue
  prompts:{ left: '#555', right: '#5865F2' },  // discord blurple
  tokens: { left: '#555', right: '#a55' },     // dim red
  files:  { left: '#555', right: '#aa6' },     // olive
};

function pickWindow(byDay, range) {
  if (!byDay) return [];
  if (range === 'all') return Object.entries(byDay);
  const days = parseInt(range, 10);
  if (!Number.isFinite(days) || days <= 0) return Object.entries(byDay);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const k = dayKey(d.getTime());
    if (byDay[k]) out.push([k, byDay[k]]);
  }
  return out;
}

function fmtHoursLabel(ms) {
  if (!ms) return '0h';
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 10) return `${h.toFixed(1)}h`;
  return `${Math.round(h)}h`;
}

function fmtNum(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

// Compute label/value pair for the requested metric.
function valueFor(aggregate, metric, range) {
  const a = aggregate || {};
  const window = pickWindow(a.byDay, range);

  const rangeLabel = range === 'all' ? 'all-time' : range;

  switch (metric) {
    case 'hours': {
      const ms = window.reduce((s, [, d]) => s + (d.activeMs || 0), 0);
      return { label: `claude · ${rangeLabel}`, value: fmtHoursLabel(ms) };
    }
    case 'streak': {
      return { label: 'streak', value: `${a.streak || 0} days` };
    }
    case 'cost': {
      const cost = window.reduce((s, [, d]) => s + (d.cost || 0), 0);
      return { label: `claude cost · ${rangeLabel}`, value: fmtCost(cost) };
    }
    case 'lines': {
      const lines = window.reduce((s, [, d]) => s + (d.linesAdded || 0), 0);
      return { label: `lines · ${rangeLabel}`, value: fmtNum(lines) };
    }
    case 'prompts': {
      const p = window.reduce((s, [, d]) => s + (d.userMessages || 0), 0);
      return { label: `prompts · ${rangeLabel}`, value: fmtNum(p) };
    }
    case 'tokens': {
      const t = window.reduce((s, [, d]) =>
        s + (d.inputTokens || 0) + (d.outputTokens || 0)
        + (d.cacheReadTokens || 0) + (d.cacheWriteTokens || 0), 0);
      return { label: `tokens · ${rangeLabel}`, value: fmtNum(t) };
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
