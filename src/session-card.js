// Per-session recap card — "here's what I built this session" as a shareable
// SVG. Renders from the live buildVars() table (current/most-recent session),
// so it covers project, model, duration, prompts, tools, files, tokens, cost.
// `claude-rpc session-card --out s.svg`.

import { VERSION } from './version.js';
import { localDateStamp } from './fmt.js';

const W = 520;
const H = 230;

const PALETTE = {
  paper:  '#f4ede0',
  ink:    '#1a1611',
  inkMute:'#5c5147',
  inkFaint:'#8a7c6d',
  rust:   '#c2491e',
  tape:   '#f2d76e',
  grass:  '#4a9462',
  blurple:'#5865f2',
};

function escapeXml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statCell(x, y, label, value, accent = PALETTE.ink) {
  return `
  <text x="${x}" y="${y}" font-family="JetBrains Mono, ui-monospace, monospace" font-size="11" font-weight="700" letter-spacing="2" fill="${PALETTE.inkMute}">${escapeXml(label.toUpperCase())}</text>
  <text x="${x}" y="${y + 27}" font-family="Space Grotesk, Inter, system-ui, sans-serif" font-size="25" font-weight="800" letter-spacing="-0.5" fill="${accent}">${escapeXml(value)}</text>`;
}

function tape(x, y, text) {
  const w = text.length * 7.4 + 22, h = 23;
  return `<g transform="translate(${x} ${y}) rotate(3)"><rect width="${w}" height="${h}" fill="${PALETTE.tape}" stroke="${PALETTE.ink}" stroke-width="1.5"/><text x="${w / 2}" y="15.5" font-family="JetBrains Mono, ui-monospace, monospace" font-size="12" font-weight="700" letter-spacing="1.1" text-anchor="middle" fill="${PALETTE.ink}">${escapeXml(text.toUpperCase())}</text></g>`;
}

// Render from a buildVars() table. `vars.project`, `.modelPretty`, `.duration`,
// `.messages`, `.tools`, `.filesEdited`, `.tokensFmt`, `.currentFilePretty`, etc.
export function renderSessionCard(vars = {}, { generatedAt = new Date() } = {}) {
  const v = vars || {};
  const C = [40, 210, 380];
  const cost = v.todayCostFmt || '$0';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Claude Code session recap">
  <defs><pattern id="dg" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${PALETTE.ink}" opacity="0.06"/></pattern></defs>
  <rect x="3" y="4" width="${W - 6}" height="${H - 7}" fill="${PALETTE.ink}"/>
  <rect x="0.75" y="0.75" width="${W - 7}" height="${H - 9}" fill="${PALETTE.paper}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
  <rect x="0.75" y="0.75" width="${W - 7}" height="${H - 9}" fill="url(#dg)"/>

  <text x="40" y="50" font-family="Space Grotesk, Inter, system-ui, sans-serif" font-size="28" font-weight="800" letter-spacing="-1" fill="${PALETTE.ink}">${escapeXml(v.project || 'this session')}</text>
  <text x="40" y="72" font-family="JetBrains Mono, ui-monospace, monospace" font-size="12" fill="${PALETTE.inkMute}">${escapeXml(`${v.modelPretty || 'Claude'} · ${v.duration || '0s'} · ${localDateStamp(generatedAt)}`)}</text>
  ${v.modelPretty ? tape(W - 150, 28, String(v.modelPretty)) : ''}

  <line x1="40" y1="92" x2="${W - 40}" y2="92" stroke="${PALETTE.ink}" stroke-width="1" opacity="0.18"/>

  ${statCell(C[0], 120, 'Prompts', String(v.messages ?? 0))}
  ${statCell(C[1], 120, 'Tool calls', String(v.tools ?? 0))}
  ${statCell(C[2], 120, 'Tokens', String(v.tokensFmt || '0'), PALETTE.rust)}

  ${statCell(C[0], 184, 'Files edited', String(v.filesEdited ?? 0), PALETTE.grass)}
  ${statCell(C[1], 184, 'Est. cost', String(cost), PALETTE.blurple)}
  ${statCell(C[2], 184, 'Reads', String(v.filesRead ?? 0))}

  <text x="40" y="${H - 16}" font-family="JetBrains Mono, ui-monospace, monospace" font-size="10" fill="${PALETTE.inkFaint}">${escapeXml(`${v.currentFilePretty ? 'last: ' + v.currentFilePretty + ' · ' : ''}claude-rpc.com · v${VERSION}`)}</text>
</svg>`;
}

export function sessionCardSvg({ vars } = {}) {
  return renderSessionCard(vars || {}, {});
}
