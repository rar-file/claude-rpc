// GitHub-profile stat card — a compact, embeddable SVG summary of your
// all-time Claude Code stats, meant to drop into a profile README via a
// raw gist URL (see `claude-rpc github-stat --gist`). Same paper/terracotta
// brand as the poster card (card.js); smaller and lifetime-focused.
//
// Output is pure SVG — GitHub renders it inline in a README <img>.

import { fmtCost } from './pricing.js';
import { VERSION } from './version.js';
import { fmtNum, fmtHours } from './fmt.js';

const W = 520;
const H = 240;

const PALETTE = {
  paper:  '#f4ede0',
  paper2: '#ebe2d2',
  paper3: '#e1d6c0',
  ink:    '#1a1611',
  inkMute:'#5c5147',
  inkFaint:'#8a7c6d',
  rust:   '#c2491e',
  tape:   '#f2d76e',
  grass:  '#4a9462',
  blurple:'#5865f2',
};

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function topLanguage(aggregate) {
  const langs = aggregate?.languages || {};
  let best = null;
  for (const [name, v] of Object.entries(langs)) {
    if (!best || (v.edits || 0) > (best.edits || 0)) best = { name, edits: v.edits || 0 };
  }
  return best;
}

// One "LABEL / value" stat cell. Label in mono caps above a display-font value.
function statCell(x, y, label, value, accent = PALETTE.ink) {
  return `
  <text x="${x}" y="${y}"
        font-family="JetBrains Mono, ui-monospace, monospace"
        font-size="11" font-weight="700" letter-spacing="2"
        fill="${PALETTE.inkMute}">${escapeXml(label.toUpperCase())}</text>
  <text x="${x}" y="${y + 28}"
        font-family="Space Grotesk, Inter, system-ui, sans-serif"
        font-size="26" font-weight="800" letter-spacing="-0.5"
        fill="${accent}">${escapeXml(value)}</text>`;
}

function tapeSticker(x, y, text, { rotate = 3 } = {}) {
  const pad = 11;
  const fontSize = 12;
  const w = text.length * 7.6 + pad * 2;
  const h = fontSize + 11;
  return `
  <g transform="translate(${x} ${y}) rotate(${rotate})">
    <rect x="0" y="0" width="${w}" height="${h}" fill="${PALETTE.tape}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
    <text x="${w / 2}" y="${h / 2 + 4.5}"
          font-family="JetBrains Mono, ui-monospace, monospace"
          font-size="${fontSize}" font-weight="700" letter-spacing="1.2"
          text-anchor="middle" fill="${PALETTE.ink}">${escapeXml(text.toUpperCase())}</text>
  </g>`;
}

// Lifetime totals straight off the aggregate (not windowed — a profile card
// is an all-time brag).
function lifetime(aggregate) {
  const a = aggregate || {};
  const tokens = (a.inputTokens || 0) + (a.outputTokens || 0)
               + (a.cacheReadTokens || 0) + (a.cacheWriteTokens || 0);
  const linesNet = a.linesNet ?? ((a.linesAdded || 0) - (a.linesRemoved || 0));
  return {
    hours: a.activeMs || 0,
    sessions: a.sessions || 0,
    prompts: a.userMessages || 0,
    tokens,
    streak: a.streak || 0,
    longestStreak: a.longestStreak || 0,
    linesNet,
    cost: a.estimatedCost || 0,
    daysSinceFirst: a.daysSinceFirst || 0,
  };
}

export function renderProfileCard(aggregate, { handle = '', generatedAt = new Date() } = {}) {
  const t = lifetime(aggregate);
  const lang = topLanguage(aggregate);
  const who = handle ? `@${String(handle).replace(/^@/, '')}` : 'on Claude Code';
  const sub = `${who} · Day ${t.daysSinceFirst} · as of ${generatedAt.toISOString().slice(0, 10)}`;
  const netStr = `${t.linesNet >= 0 ? '+' : '−'}${fmtNum(Math.abs(t.linesNet))}`;

  // 3 columns × 2 rows of stats.
  const C = [40, 210, 380];

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Claude Code stats">
  <defs>
    <pattern id="dg" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="1" fill="${PALETTE.ink}" opacity="0.06"/>
    </pattern>
  </defs>
  <rect x="3" y="4" width="${W - 6}" height="${H - 7}" fill="${PALETTE.ink}"/>
  <rect x="0.75" y="0.75" width="${W - 7}" height="${H - 9}" fill="${PALETTE.paper}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
  <rect x="0.75" y="0.75" width="${W - 7}" height="${H - 9}" fill="url(#dg)"/>

  <!-- header -->
  <text x="40" y="50"
        font-family="Space Grotesk, Inter, system-ui, sans-serif"
        font-size="30" font-weight="800" letter-spacing="-1"
        fill="${PALETTE.ink}">Claude Code</text>
  <text x="40" y="72"
        font-family="JetBrains Mono, ui-monospace, monospace"
        font-size="12" fill="${PALETTE.inkMute}">${escapeXml(sub)}</text>
  ${lang ? tapeSticker(W - 150, 28, lang.name, { rotate: 3 }) : ''}

  <line x1="40" y1="92" x2="${W - 40}" y2="92" stroke="${PALETTE.ink}" stroke-width="1" opacity="0.18"/>

  <!-- stat grid: row 1 -->
  ${statCell(C[0], 120, 'Time with Claude', fmtHours(t.hours), PALETTE.rust)}
  ${statCell(C[1], 120, 'Sessions', fmtNum(t.sessions))}
  ${statCell(C[2], 120, 'Streak', t.streak ? `${t.streak}d` : '—')}

  <!-- stat grid: row 2 -->
  ${statCell(C[0], 184, 'Prompts', fmtNum(t.prompts))}
  ${statCell(C[1], 184, 'Tokens', fmtNum(t.tokens))}
  ${statCell(C[2], 184, 'Lines', netStr, PALETTE.grass)}

  <!-- footer -->
  <text x="40" y="${H - 18}"
        font-family="JetBrains Mono, ui-monospace, monospace"
        font-size="11" fill="${PALETTE.inkFaint}">${escapeXml(`best streak ${t.longestStreak}d · ≈${fmtCost(t.cost)} · claude-rpc.com`)}</text>
</svg>`;
}

// Top-level convenience matching badge.js / card.js shape.
export function profileCardSvg({ aggregate, handle = '' } = {}) {
  return renderProfileCard(aggregate, { handle });
}
