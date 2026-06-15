// Vendored shields-style SVG renderer. Mirrors src/badge.js renderBadge
// from the main repo so the community badges share visual language with
// users' personal `claude-rpc badge` output. Kept inline to keep the
// worker dep-free (no bundler step needed for `wrangler deploy`).

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Verdana 11px approximation — matches what shields.io uses.
function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    if (/[il1.\s]/.test(ch)) w += 4;
    else if (/[A-Z]/.test(ch)) w += 8;
    else w += 6.5;
  }
  return Math.ceil(w);
}

// Byte-for-byte mirror of src/fmt.js fmtNum — the worker deploys dependency-free
// and can't import across the package boundary. Keep the two in sync.
export function fmtNum(n) {
  if (!n) return '0';
  const neg = n < 0 ? '-' : '';
  const v = Math.abs(n);
  if (v < 1000) return neg + Math.round(v);
  for (const [suf, div, prec] of [['k', 1e3, 1], ['M', 1e6, 2], ['B', 1e9, 2]]) {
    const s = (v / div).toFixed(prec);
    if (Number(s) < 1000) return neg + s + suf;
  }
  return neg + (v / 1e9).toFixed(2) + 'B';
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
