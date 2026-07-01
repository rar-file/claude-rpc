// Activity calendar — a GitHub-contributions-style year heatmap of Claude
// Code activity, rendered as an embeddable SVG (paper/terracotta brand).
// `claude-rpc calendar --out cal.svg [--gist]`.

import { dayKey } from './scanner.js';
import { VERSION } from './version.js';

const PALETTE = {
  paper:  '#f4ede0',
  ink:    '#1a1611',
  inkMute:'#5c5147',
  inkFaint:'#8a7c6d',
  empty:  '#e1d6c0',
  l1:     '#f6dccb',
  l2:     '#f08a4a',
  l3:     '#c2491e',
  l4:     '#8f3415',
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function escapeXml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// activeMs → one of 5 intensity buckets (0..4). 4h saturates.
function level(ms) {
  if (!ms) return 0;
  const h = ms / 3_600_000;
  if (h < 0.5) return 1;
  if (h < 1.5) return 2;
  if (h < 3) return 3;
  return 4;
}
const FILL = [PALETTE.empty, PALETTE.l1, PALETTE.l2, PALETTE.l3, PALETTE.l4];

export function renderCalendar(aggregate, { weeks = 53, generatedAt = new Date() } = {}) {
  const byDay = aggregate?.byDay || {};
  const cell = 12, gap = 3, step = cell + gap;
  const padX = 36, padTop = 68, padBottom = 30;

  // Build the grid ending today. Align the last column to today's weekday so
  // rows read Sun..Sat like GitHub. We render `weeks` columns back from today.
  const today = new Date(generatedAt);
  today.setHours(0, 0, 0, 0);
  const todayDow = today.getDay(); // 0=Sun
  const totalDays = (weeks - 1) * 7 + todayDow + 1;

  let cells = '';
  let monthLabels = '';
  let lastMonth = -1;
  let totalActiveMs = 0, activeDays = 0;

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - (totalDays - 1 - i));
    const col = Math.floor(i / 7);
    const row = d.getDay();
    const key = dayKey(d);
    const ms = byDay[key]?.activeMs || 0;
    if (ms > 0) { totalActiveMs += ms; activeDays += 1; }
    const x = padX + col * step;
    const y = padTop + row * step;
    cells += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${FILL[level(ms)]}" stroke="${PALETTE.ink}" stroke-width="0.4"/>`;
    // Month label when a new month starts in the top row region.
    if (d.getMonth() !== lastMonth && d.getDate() <= 7) {
      lastMonth = d.getMonth();
      monthLabels += `<text x="${x}" y="${padTop - 9}" font-family="JetBrains Mono, ui-monospace, monospace" font-size="10" fill="${PALETTE.inkMute}">${MONTHS[d.getMonth()]}</text>`;
    }
  }

  const W = padX + weeks * step + 14;
  const H = padTop + 7 * step + padBottom;
  const totalHours = (totalActiveMs / 3_600_000).toFixed(0);
  let legend = '';
  for (let l = 0; l < 5; l++) {
    legend += `<rect x="${W - 150 + l * 16}" y="${H - 20}" width="${cell}" height="${cell}" rx="2" fill="${FILL[l]}" stroke="${PALETTE.ink}" stroke-width="0.4"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Claude Code activity calendar">
  <rect width="${W}" height="${H}" fill="${PALETTE.paper}"/>
  <text x="${padX}" y="28" font-family="Space Grotesk, Inter, system-ui, sans-serif" font-size="20" font-weight="800" fill="${PALETTE.ink}">a year on Claude Code</text>
  <text x="${padX}" y="44" font-family="JetBrains Mono, ui-monospace, monospace" font-size="11" fill="${PALETTE.inkMute}">${escapeXml(activeDays)} active days · ${escapeXml(totalHours)}h · as of ${generatedAt.toISOString().slice(0, 10)}</text>
  ${monthLabels}
  ${cells}
  <text x="${W - 170}" y="${H - 10}" font-family="JetBrains Mono, ui-monospace, monospace" font-size="9" fill="${PALETTE.inkFaint}">less</text>
  ${legend}
  <text x="${W - 28}" y="${H - 10}" font-family="JetBrains Mono, ui-monospace, monospace" font-size="9" fill="${PALETTE.inkFaint}">more</text>
  <text x="${padX}" y="${H - 8}" font-family="JetBrains Mono, ui-monospace, monospace" font-size="9" fill="${PALETTE.inkFaint}">claude-rpc.com · v${VERSION}</text>
</svg>`;
}

export function calendarSvg({ aggregate } = {}) {
  return renderCalendar(aggregate, {});
}
