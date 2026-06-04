// Renders site/img/promo.gif — a clean looping animation of the Discord
// presence card cycling states. Server-side + reproducible: builds SVG frames,
// rasterizes with rsvg-convert, assembles with ImageMagick. No browser needed.
//   node launch/make-promo-gif.mjs
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const W = 640, H = 360;
// Each step: the status line + a (rising) token count. Cursor blinks per frame.
const STEPS = [
  { line: 'Editing src/daemon.js',        tok: '1.21M' },
  { line: 'Editing src/daemon.js',        tok: '1.24M' },
  { line: 'Running tests in claude-rpc',  tok: '1.31M' },
  { line: 'Running tests in claude-rpc',  tok: '1.33M' },
  { line: 'All tests passed - shipping',  tok: '1.38M' },
  { line: 'Just shipped v0.13.0',         tok: '1.40M' },
  { line: 'Just shipped v0.13.0',         tok: '1.40M' },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function frame({ line, tok }, cursorOn) {
  // line text starts at x=178, font-size 17 monospace → ~10.2px advance/char.
  const cur = cursorOn ? `<rect x="${Math.round(178 + line.length * 10.2 + 4)}" y="150" width="8" height="17" fill="#d97757"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#f4ede0"/>
  <rect width="${W}" height="8" fill="#d97757"/>
  <g font-family="DejaVu Sans Mono, monospace">
    <!-- card -->
    <rect x="60" y="64" width="520" height="232" rx="12" fill="#ebe2d2" stroke="#2b2722" stroke-width="2.5"/>
    <!-- avatar -->
    <defs><linearGradient id="av" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#d97757"/><stop offset="1" stop-color="#b8552f"/></linearGradient></defs>
    <rect x="86" y="92" width="72" height="72" rx="12" fill="url(#av)"/>
    <circle cx="156" cy="162" r="11" fill="#5a7d4f" stroke="#ebe2d2" stroke-width="4"/>
    <!-- text -->
    <text x="178" y="116" font-size="20" font-weight="700" fill="#2b2722">Claude Code</text>
    <text x="178" y="164" font-size="17" fill="#6b6357">${esc(line)}</text>${cur}
    <text x="178" y="190" font-size="14" fill="#9a9183">claude-rpc · Opus 4.8</text>
    <!-- stat chip -->
    <rect x="86" y="212" width="468" height="34" rx="6" fill="#f4ede0" stroke="#2b2722" stroke-width="1.5"/>
    <text x="100" y="234" font-size="15" fill="#6b6357">3.2h today · ${tok} tokens · 12d streak</text>
    <!-- button -->
    <rect x="86" y="256" width="150" height="30" rx="6" fill="#5865F2"/>
    <text x="161" y="276" font-size="14" font-weight="700" fill="#ffffff" text-anchor="middle">Get claude-rpc</text>
    <!-- footer -->
    <text x="${W - 60}" y="332" font-size="14" font-weight="700" fill="#6b6357" text-anchor="end">claude-rpc.vercel.app</text>
  </g>
</svg>`;
}

const dir = mkdtempSync(join(tmpdir(), 'promo-'));
const pngs = [];
let i = 0;
for (const step of STEPS) {
  for (const cursor of [true, false]) {          // blink
    const svg = join(dir, `f${String(i).padStart(2, '0')}.svg`);
    const png = join(dir, `f${String(i).padStart(2, '0')}.png`);
    writeFileSync(svg, frame(step, cursor));
    execSync(`rsvg-convert -w ${W} -h ${H} "${svg}" -o "${png}"`);
    pngs.push(png);
    i++;
  }
}
mkdirSync('site/img', { recursive: true });
// 18cs/frame ≈ 5.5fps; -layers Optimize keeps it small; loop forever.
execSync(`convert -delay 18 -loop 0 ${pngs.map((p) => `"${p}"`).join(' ')} -layers Optimize site/img/promo.gif`);
console.log('wrote site/img/promo.gif (' + pngs.length + ' frames)');
