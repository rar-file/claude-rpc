// Poster-style SVG card — designed to be screenshotted and shared.
//
// Renders an 880×540 magazine-style summary for a given range:
//   year on claude  /  month on claude  /  week on claude  /  all-time
//
// Stats: total hours, prompts, tokens, lines added, cost, top language,
// top file, longest streak, top weekday, peak hour. Visual style matches
// the indie cream-paper landing page — same palette, same monospace +
// display-font split.
//
// Output is SVG only (no PNG dep). Modern Discord / GitHub render the SVG
// inline; for hard-copy sharing, screenshot or convert via any web tool.

import { dayKey } from './scanner.js';
import { fmtCost } from './pricing.js';
import { rangeToDays, rangeLabel, pickWindow } from './badge.js';
import { VERSION } from './version.js';
import { fmtNum, fmtHours } from './fmt.js';

const W = 880;
const H = 540;

const PALETTE = {
  paper: '#f4ede0',
  paper2: '#ebe2d2',
  paper3: '#e1d6c0',
  paper4: '#d6c8ac',
  ink:    '#1a1611',
  inkSoft:'#2d2520',
  inkMute:'#5c5147',
  inkFaint:'#8a7c6d',
  rust:   '#c2491e',
  rust3:  '#f08a4a',
  tape:   '#f2d76e',
  grass:  '#4a9462',
  blurple:'#5865f2',
};

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rangeTitle(range) {
  const rl = rangeLabel(range);
  if (rl === 'all-time') return 'on claude';
  return `${rl} on claude`;
}

// Roll up a windowed metric across the active range.
function rollup(aggregate, range) {
  const window = pickWindow(aggregate?.byDay, range);
  const out = {
    activeMs: 0,
    userMessages: 0,
    toolCalls: 0,
    tokens: 0,
    linesAdded: 0,
    linesRemoved: 0,
    cost: 0,
    sessions: 0,
    days: 0,
    daysActive: 0,
  };
  for (const [, d] of window) {
    out.days += 1;
    if ((d.activeMs || 0) > 0) out.daysActive += 1;
    out.activeMs += d.activeMs || 0;
    out.userMessages += d.userMessages || 0;
    out.toolCalls += d.toolCalls || 0;
    out.tokens += (d.inputTokens || 0) + (d.outputTokens || 0)
                + (d.cacheReadTokens || 0) + (d.cacheWriteTokens || 0);
    out.linesAdded += d.linesAdded || 0;
    out.linesRemoved += d.linesRemoved || 0;
    out.cost += d.cost || 0;
    out.sessions += d.sessions || 0;
  }
  return out;
}

// Best weekday by active time, computed from byWeekday on the aggregate.
function topWeekday(aggregate) {
  const wd = aggregate?.byWeekday || {};
  let best = null;
  for (const [k, v] of Object.entries(wd)) {
    const day = Number(k);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue; // out-of-range key → skip, no blank name + stray "(3h)"
    if (!best || (v.activeMs || 0) > (best.ms || 0)) best = { day, ms: v.activeMs || 0 };
  }
  return best;
}

// Top language by edits.
function topLanguage(aggregate) {
  const langs = aggregate?.languages || {};
  let best = null;
  for (const [name, v] of Object.entries(langs)) {
    if (!best || (v.edits || 0) > (best.edits || 0)) best = { name, edits: v.edits || 0 };
  }
  return best;
}

// Top edited file (basename only — full path would overflow).
function topFile(aggregate) {
  const list = aggregate?.topEditedFiles || [];
  if (!list.length) return null;
  const top = list[0];
  const p = String(top.path || '').replace(/\\/g, '/');
  const name = p.split('/').pop() || p;
  return { name, count: top.count };
}

// Compute peak hour-of-day (24h clock).
function peakHourLabel(aggregate) {
  const ph = aggregate?.peakHour;
  if (!ph || ph.hour == null) return null;
  const h = Number(ph.hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null; // corrupt aggregate → no label, not "99:00"/"NaN:00"
  return `${String(h).padStart(2, '0')}:00`;
}

// ── SVG building blocks ─────────────────────────────────────────────────

function paperDefs() {
  return `
  <defs>
    <pattern id="dotgrid" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="1" fill="${PALETTE.ink}" opacity="0.07"/>
    </pattern>
    <filter id="noise" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" stitchTiles="stitch"/>
      <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.05 0"/>
    </filter>
  </defs>`;
}

function background() {
  return `
  <rect width="${W}" height="${H}" fill="${PALETTE.paper}"/>
  <rect width="${W}" height="${H}" fill="url(#dotgrid)"/>
  <rect width="${W}" height="${H}" filter="url(#noise)" opacity="0.6"/>`;
}

function tapeSticker(x, y, text, { rotate = -2, bg = PALETTE.tape, fg = PALETTE.ink } = {}) {
  const pad = 12;
  const fontSize = 14;
  const w = text.length * 8.4 + pad * 2;
  const h = fontSize + 12;
  return `
  <g transform="translate(${x} ${y}) rotate(${rotate})">
    <rect x="0" y="0" width="${w}" height="${h}" fill="${bg}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
    <rect x="2" y="2" width="${w}" height="${h}" fill="none" stroke="${PALETTE.ink}" stroke-width="1.5" opacity="0.18"/>
    <text x="${w / 2}" y="${h / 2 + 5}"
          font-family="JetBrains Mono, ui-monospace, monospace"
          font-size="${fontSize}" font-weight="700"
          letter-spacing="1.5"
          text-anchor="middle" fill="${fg}">${escapeXml(text.toUpperCase())}</text>
  </g>`;
}

function statBox(x, y, w, h, { label, value, sub = '', accent = PALETTE.ink, tilt = 0 } = {}) {
  // Drop-shadow style: a second rect offset by (2,2) under the main one.
  return `
  <g transform="translate(${x} ${y}) rotate(${tilt})">
    <rect x="2" y="3" width="${w}" height="${h}" fill="${PALETTE.ink}"/>
    <rect x="0" y="0" width="${w}" height="${h}" fill="${PALETTE.paper}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
    <text x="18" y="28"
          font-family="JetBrains Mono, ui-monospace, monospace"
          font-size="11" font-weight="700"
          letter-spacing="2"
          fill="${PALETTE.inkMute}">${escapeXml(label.toUpperCase())}</text>
    <text x="18" y="${h - 24}"
          font-family="Space Grotesk, Inter, system-ui, sans-serif"
          font-size="34" font-weight="800"
          fill="${accent}">${escapeXml(value)}</text>
    ${sub ? `<text x="18" y="${h - 8}"
          font-family="JetBrains Mono, ui-monospace, monospace"
          font-size="11"
          fill="${PALETTE.inkMute}">${escapeXml(sub)}</text>` : ''}
  </g>`;
}

// Mini bar chart of daily active hours across the windowed range.
// Used as a strip across the bottom of the card.
function activityStrip(x, y, w, h, byDay, range) {
  const window = pickWindow(byDay, range).reverse();   // oldest → newest
  if (!window.length) return '';
  const max = Math.max(1, ...window.map(([, d]) => d.activeMs || 0));
  const N = window.length;
  const colW = w / N;
  const bw = Math.max(1, colW - 1.5);
  let bars = '';
  for (let i = 0; i < N; i++) {
    const [, d] = window[i];
    const ratio = (d.activeMs || 0) / max;
    const bh = Math.max(0, ratio * h);
    bars += `<rect x="${x + i * colW}" y="${y + (h - bh)}" width="${bw}" height="${bh}" fill="${PALETTE.rust}" opacity="${0.45 + ratio * 0.45}"/>`;
  }
  return `<g>${bars}</g>`;
}

// Heatmap-like dot row of the last N days.
function dotRow(x, y, byDay, range) {
  const window = pickWindow(byDay, range).reverse();
  const sz = 9;
  const gap = 2;
  let svg = '';
  for (let i = 0; i < window.length; i++) {
    const [, d] = window[i];
    const ms = d.activeMs || 0;
    const intensity = ms === 0 ? 0 : Math.min(1, ms / (4 * 3_600_000)); // 4h = full
    const fill = intensity === 0
      ? PALETTE.paper3
      : intensity < 0.34 ? '#f6dccb'
      : intensity < 0.67 ? PALETTE.rust3
      : PALETTE.rust;
    svg += `<rect x="${x + i * (sz + gap)}" y="${y}" width="${sz}" height="${sz}" fill="${fill}" stroke="${PALETTE.ink}" stroke-width="0.5"/>`;
  }
  return svg;
}

// ── public entry point ─────────────────────────────────────────────────

export function renderCard(aggregate, { range = 'year', generatedAt = new Date() } = {}) {
  const r = rollup(aggregate, range);
  const lang = topLanguage(aggregate);
  const file = topFile(aggregate);
  const wd = topWeekday(aggregate);
  const peak = peakHourLabel(aggregate);
  const streak = aggregate?.streak || 0;
  const longestStreak = aggregate?.longestStreak || 0;
  const linesNet = r.linesAdded - r.linesRemoved;
  const allTimeHours = ((aggregate?.activeMs || 0) / 3_600_000).toFixed(1);

  const subtitle = `${escapeXml(r.daysActive)} active days / ${escapeXml(rangeLabel(range))} ending ${escapeXml(generatedAt.toISOString().slice(0, 10))}`;

  // Layout grid
  //   Title block          80 →  W-80
  //   Hero hours card     (60, 130) 380×170
  //   Right-column stats  (470, 130) → 4 mini boxes
  //   Activity strip       60, 332, W-120, 50
  //   Footer credits       60, 480

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  ${paperDefs()}
  ${background()}

  <!-- ── title ── -->
  <g transform="translate(60 60)">
    <text x="0" y="0"
          font-family="Space Grotesk, Inter, system-ui, sans-serif"
          font-size="48" font-weight="800"
          letter-spacing="-1.5"
          fill="${PALETTE.ink}">${escapeXml(rangeTitle(range))}</text>
    <text x="0" y="26"
          font-family="JetBrains Mono, ui-monospace, monospace"
          font-size="13"
          fill="${PALETTE.inkMute}">${subtitle}</text>
  </g>
  ${tapeSticker(W - 220, 40, `claude-rpc · v${VERSION}`, { rotate: 3 })}

  <!-- ── hero hours card ── -->
  <g transform="translate(60 130)">
    <rect x="3" y="4" width="380" height="170" fill="${PALETTE.ink}"/>
    <rect x="0" y="0" width="380" height="170" fill="${PALETTE.paper}" stroke="${PALETTE.ink}" stroke-width="2"/>
    <text x="22" y="36"
          font-family="JetBrains Mono, ui-monospace, monospace"
          font-size="12" font-weight="700"
          letter-spacing="2.5"
          fill="${PALETTE.inkMute}">TIME WITH CLAUDE</text>
    <text x="22" y="118"
          font-family="Space Grotesk, Inter, system-ui, sans-serif"
          font-size="82" font-weight="800"
          letter-spacing="-3"
          fill="${PALETTE.rust}">${escapeXml(fmtHours(r.activeMs))}</text>
    <text x="22" y="148"
          font-family="JetBrains Mono, ui-monospace, monospace"
          font-size="13"
          fill="${PALETTE.ink}">${escapeXml(r.daysActive)} days · ${escapeXml(fmtNum(r.sessions || 0))} sessions · streak ${escapeXml(streak)} (best ${escapeXml(longestStreak)})</text>
  </g>

  <!-- ── right-column stats (2x2 grid) ── -->
  ${statBox(470, 130, 170, 82, { label: 'prompts',  value: fmtNum(r.userMessages), accent: PALETTE.ink, tilt: -0.8 })}
  ${statBox(650, 130, 170, 82, { label: 'tokens',   value: fmtNum(r.tokens),       accent: PALETTE.ink, tilt: 0.6 })}
  ${statBox(470, 218, 170, 82, { label: 'lines',    value: `${linesNet >= 0 ? '+' : '−'}${fmtNum(Math.abs(linesNet))}`, sub: `${fmtNum(r.linesAdded)} added`, accent: PALETTE.grass, tilt: 0.6 })}
  ${statBox(650, 218, 170, 82, { label: 'cost',     value: fmtCost(r.cost),        sub: `≈ ${fmtCost(r.cost / Math.max(1, r.daysActive))}/day`, accent: PALETTE.blurple, tilt: -0.5 })}

  <!-- ── activity strip ── -->
  <g>
    <text x="60" y="328"
          font-family="JetBrains Mono, ui-monospace, monospace"
          font-size="11" font-weight="700"
          letter-spacing="2.5"
          fill="${PALETTE.inkMute}">DAILY ACTIVITY</text>
    <rect x="60" y="335" width="${W - 120}" height="62" fill="${PALETTE.paper2}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
    ${activityStrip(64, 337, W - 128, 58, aggregate?.byDay, range)}
  </g>

  <!-- ── footer stats row ── -->
  <g transform="translate(60 420)">
    <text x="0" y="0"
          font-family="JetBrains Mono, ui-monospace, monospace"
          font-size="11" font-weight="700"
          letter-spacing="2.5"
          fill="${PALETTE.inkMute}">HIGHLIGHTS</text>

    <g transform="translate(0 16)">
      <text font-family="JetBrains Mono, ui-monospace, monospace" font-size="13" fill="${PALETTE.ink}">
        <tspan x="0"  dy="14" fill="${PALETTE.inkMute}">top language</tspan><tspan dx="10" font-weight="700">${escapeXml(lang ? lang.name : '—')}</tspan><tspan dx="6" fill="${PALETTE.inkFaint}">${escapeXml(lang ? `(${fmtNum(lang.edits)} edits)` : '')}</tspan>
        <tspan x="0"  dy="20" fill="${PALETTE.inkMute}">hotspot file</tspan><tspan dx="14" font-weight="700">${escapeXml(file ? file.name : '—')}</tspan><tspan dx="6" fill="${PALETTE.inkFaint}">${escapeXml(file ? `(× ${fmtNum(file.count)})` : '')}</tspan>
        <tspan x="0"  dy="20" fill="${PALETTE.inkMute}">peak day</tspan><tspan dx="36" font-weight="700">${escapeXml(wd && wd.day != null ? WEEKDAY[wd.day] : '—')}</tspan><tspan dx="6" fill="${PALETTE.inkFaint}">${escapeXml(wd ? `(${fmtHours(wd.ms)})` : '')}</tspan>
        <tspan x="0"  dy="20" fill="${PALETTE.inkMute}">peak hour</tspan><tspan dx="30" font-weight="700">${escapeXml(peak || '—')}</tspan>
      </text>
    </g>
  </g>

  <!-- ── credits ── -->
  <g transform="translate(${W - 60} ${H - 24})" text-anchor="end">
    <text font-family="JetBrains Mono, ui-monospace, monospace" font-size="10"
          fill="${PALETTE.inkFaint}">${escapeXml(allTimeHours)}h all-time · claude-rpc.com</text>
  </g>
</svg>`;
}

// Top-level convenience matching badge.js shape.
export function cardSvg({ aggregate, range = 'year' }) {
  return renderCard(aggregate, { range });
}
