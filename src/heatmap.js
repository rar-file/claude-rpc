// Year heatmap + stats-with-heatmap card — ONE renderer shared by the CLI
// (`claude-rpc calendar`) and the worker's live /heatmap/<h>.svg and
// /stats/<h>.svg endpoints. The worker imports this file across the package
// boundary (wrangler bundles it), so it must stay PURE: no imports, no Node
// APIs, no Date-of-the-local-machine assumptions. Every date is a
// 'YYYY-MM-DD' string handled with UTC arithmetic, so the same series
// renders identically on a laptop and in a Cloudflare isolate.
//
// Input series shape (also the profile payload's `daily` field):
//   { end: 'YYYY-MM-DD', tokens: number[], activeMin: number[] }
// Arrays run oldest → newest; the LAST element is `end`. Arrays may be
// shorter than a year (leading zeros trimmed) — missing days read as 0.

export const HEATMAP_WEEKS = 53;
export const HEATMAP_DAYS = HEATMAP_WEEKS * 7; // 371 — always covers the 53-column grid

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;

const PALETTE = {
  paper: '#f4ede0', paper2: '#ebe2d2', empty: '#e1d6c0',
  ink: '#1a1611', inkMute: '#5c5147', inkFaint: '#8a7c6d',
  rust: '#c2491e', amber: '#c0851f', blue: '#3f6f9f', grass: '#4a9462', tape: '#f2d76e',
};

// Per-metric 4-step ramps (level 1..4); level 0 is always PALETTE.empty.
const RAMPS = {
  tokens: ['#f6dccb', '#f08a4a', '#c2491e', '#8f3415'],
  hours:  ['#d5e6c8', '#8fc27a', '#4a9462', '#2c6b3f'],
};

const MONO = 'JetBrains Mono, ui-monospace, monospace';
const DISPLAY = 'Space Grotesk, Inter, system-ui, sans-serif';

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Same rules as src/fmt.js fmtNum / fmtHours (inlined — this module is pure).
function fmtNum(n) {
  if (!n) return '0';
  const v = Math.abs(n);
  if (v < 1000) return String(Math.round(v));
  for (const [suf, div, prec] of [['k', 1e3, 1], ['M', 1e6, 2], ['B', 1e9, 2]]) {
    const s = (v / div).toFixed(prec);
    if (Number(s) < 1000) return s + suf;
  }
  return (v / 1e9).toFixed(2) + 'B';
}
function fmtMinutes(min) {
  if (!min) return '0m';
  if (min < 60) return `${Math.round(min)}m`;
  const h = min / 60;
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`;
}

// ── dates (UTC arithmetic on YYYY-MM-DD) ─────────────────────────────────

export function isDayKey(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
export function dayToMs(key) { return Date.parse(`${key}T00:00:00Z`); }
export function msToDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function shortDate(key) {
  const d = new Date(dayToMs(key));
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// Normalize a series to exactly `days` values ending at `end` for one metric.
// metric: 'tokens' | 'hours' (hours reads activeMin).
export function seriesValues(series, metric = 'tokens', days = HEATMAP_DAYS) {
  const src = (metric === 'hours' ? series?.activeMin : series?.tokens) || [];
  const out = new Array(days).fill(0);
  const n = Math.min(src.length, days);
  for (let i = 0; i < n; i++) {
    const v = Number(src[src.length - 1 - i]);
    out[days - 1 - i] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return out;
}

// Intensity cutoffs from the user's OWN distribution (quartiles of non-zero
// days, like GitHub). Token days span 5+ orders of magnitude between users, so
// fixed thresholds would paint one person all-dark and another all-pale.
export function levelCutoffs(values) {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!nz.length) return [Infinity, Infinity, Infinity];
  const q = (p) => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
  return [q(0.25), q(0.5), q(0.75)];
}
export function levelOf(v, cut) {
  if (!(v > 0)) return 0;
  if (v < cut[0]) return 1;
  if (v < cut[1]) return 2;
  if (v < cut[2]) return 3;
  return 4;
}

// Facts the card prints under the grid. All computed over the visible window.
export function seriesFacts(series, metric = 'tokens', days = HEATMAP_DAYS) {
  const end = isDayKey(series?.end) ? series.end : null;
  const vals = seriesValues(series, metric, days);
  const endMs = end ? dayToMs(end) : 0;
  let total = 0, activeDays = 0, busiest = null, run = 0, longestRun = 0;
  const byWeekday = new Array(7).fill(0);
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v > 0) {
      total += v; activeDays++; run++;
      longestRun = Math.max(longestRun, run);
      if (end) {
        const key = msToDay(endMs - (vals.length - 1 - i) * DAY_MS);
        if (!busiest || v > busiest.value) busiest = { date: key, value: v };
        byWeekday[new Date(dayToMs(key)).getUTCDay()] += v;
      }
    } else run = 0;
  }
  // Current run: ending today, or yesterday (today may simply not have started).
  let current = 0;
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i] > 0) current++;
    else if (i === vals.length - 1) continue;
    else break;
  }
  let bestWeekday = null;
  for (let d = 0; d < 7; d++) if (byWeekday[d] > 0 && (bestWeekday == null || byWeekday[d] > byWeekday[bestWeekday])) bestWeekday = d;
  return {
    total, activeDays, longestRun, currentRun: current,
    busiest,
    avgPerActiveDay: activeDays ? total / activeDays : 0,
    bestWeekday: bestWeekday == null ? null : WEEKDAYS[bestWeekday],
  };
}

function fmtMetric(v, metric) { return metric === 'hours' ? fmtMinutes(v) : fmtNum(v); }

// ── the grid ─────────────────────────────────────────────────────────────

// Returns { svg, width, height } for a 53-column Sun..Sat grid at (x, y),
// month labels above, Mon/Wed/Fri labels to the left (inside x).
function grid(x, y, series, metric, { cell = 12, gap = 3, empty = false } = {}) {
  const step = cell + gap;
  const end = isDayKey(series?.end) ? series.end : null;
  const ramp = RAMPS[metric] || RAMPS.tokens;
  const fill = (l) => (l === 0 ? PALETTE.empty : ramp[l - 1]);
  const endMs = end ? dayToMs(end) : 0;
  const endDow = end ? new Date(endMs).getUTCDay() : 6;
  const total = (HEATMAP_WEEKS - 1) * 7 + endDow + 1; // last column ends on `end`
  const vals = seriesValues(series, metric, total);
  const cut = levelCutoffs(vals);
  const labelW = 30;
  const gx = x + labelW;

  let cells = '', months = '', lastMonth = -1, lastLabelCol = -9;
  for (let i = 0; i < total; i++) {
    const col = Math.floor(i / 7), row = i % 7;
    const cx = gx + col * step, cy = y + row * step;
    const key = end ? msToDay(endMs - (total - 1 - i) * DAY_MS) : null;
    const v = vals[i];
    const l = empty ? 0 : levelOf(v, cut);
    const title = key ? `<title>${escapeXml(`${shortDate(key)}: ${fmtMetric(v, metric)}`)}</title>` : '';
    cells += `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="2" fill="${fill(l)}" stroke="${PALETTE.ink}" stroke-width="0.4" stroke-opacity="0.55">${title}</rect>`;
    if (row === 0 && key) {
      const m = new Date(dayToMs(key)).getUTCMonth();
      if (m !== lastMonth) {
        // Skip a label squeezed against the previous one (partial first month).
        if (col - lastLabelCol >= 3) {
          months += `<text x="${cx}" y="${y - 7}" font-family="${MONO}" font-size="10" fill="${PALETTE.inkMute}">${MONTHS[m]}</text>`;
          lastLabelCol = col;
        }
        lastMonth = m;
      }
    }
  }
  let rows = '';
  for (const [r, name] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]) {
    rows += `<text x="${x}" y="${y + r * step + cell - 2}" font-family="${MONO}" font-size="9" fill="${PALETTE.inkFaint}">${name}</text>`;
  }
  return { svg: months + rows + cells, width: labelW + HEATMAP_WEEKS * step - gap, height: 7 * step - gap };
}

function legend(xRight, y, metric) {
  const ramp = RAMPS[metric] || RAMPS.tokens;
  const fills = [PALETTE.empty, ...ramp];
  const sw = 12, sg = 4;
  const x0 = xRight - fills.length * (sw + sg) + sg;
  let s = `<text x="${x0 - 8}" y="${y + 10}" text-anchor="end" font-family="${MONO}" font-size="9" fill="${PALETTE.inkFaint}">less</text>`;
  fills.forEach((f, i) => {
    s += `<rect x="${x0 + i * (sw + sg)}" y="${y}" width="${sw}" height="${sw}" rx="2" fill="${f}" stroke="${PALETTE.ink}" stroke-width="0.4" stroke-opacity="0.55"/>`;
  });
  s += `<text x="${xRight + 8}" y="${y + 10}" font-family="${MONO}" font-size="9" fill="${PALETTE.inkFaint}">more</text>`;
  return s;
}

function frame(W, H, inner, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${escapeXml(label)}">
  <defs>
    <pattern id="dg" width="22" height="22" patternUnits="userSpaceOnUse">
      <circle cx="1" cy="1" r="1" fill="${PALETTE.ink}" opacity="0.07"/>
    </pattern>
  </defs>
  <rect x="3" y="4" width="${W - 6}" height="${H - 7}" fill="${PALETTE.ink}"/>
  <rect x="0.75" y="0.75" width="${W - 7}" height="${H - 9}" fill="${PALETTE.paper}" stroke="${PALETTE.ink}" stroke-width="2"/>
  <rect x="0.75" y="0.75" width="${W - 7}" height="${H - 9}" fill="url(#dg)"/>
${inner}
</svg>`;
}

function spark(cx, cy, r, fill) {
  const i = r * 0.16;
  return `<path d="M ${cx} ${cy - r} C ${cx + i} ${cy - i} ${cx + i} ${cy - i} ${cx + r} ${cy} C ${cx + i} ${cy + i} ${cx + i} ${cy + i} ${cx} ${cy + r} C ${cx - i} ${cy + i} ${cx - i} ${cy + i} ${cx - r} ${cy} C ${cx - i} ${cy - i} ${cx - i} ${cy - i} ${cx} ${cy - r} Z" fill="${fill}"/>`;
}

function verifiedStamp(x, y) {
  return `<g transform="translate(${x} ${y})">
    <circle r="11" fill="${PALETTE.grass}"/>
    <path d="M -4.6 0 L -1.4 3.4 L 5 -4" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  </g>`;
}

function clip(s, n) { s = String(s || ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; }

function metricOf(m) { return m === 'hours' ? 'hours' : 'tokens'; }

// ── standalone heatmap (GET /heatmap/<h>.svg, `claude-rpc calendar`) ─────

// opts: { series, metric, title?, subtitle?, footer? , empty? }
export function renderHeatmap({ series, metric = 'tokens', title, subtitle, footer, empty = false } = {}) {
  metric = metricOf(metric);
  const W = 880;
  const g = grid(28, 98, series, metric, { empty });
  const H = 98 + g.height + 56;
  const f = seriesFacts(series, metric);
  const what = metric === 'hours' ? 'hours' : 'tokens';
  const sub = subtitle != null ? subtitle
    : `${f.activeDays} active days · ${fmtMetric(f.total, metric)}${metric === 'hours' ? ' with Claude' : ' tokens'} in the last year`;
  const inner = `
  ${spark(40, 37, 10, metric === 'hours' ? PALETTE.grass : PALETTE.rust)}
  <text x="58" y="44" font-family="${DISPLAY}" font-size="22" font-weight="800" letter-spacing="-0.6" fill="${PALETTE.ink}">${escapeXml(clip(title || 'a year on Claude Code', 48))}</text>
  <text x="28" y="66" font-family="${MONO}" font-size="11" fill="${PALETTE.inkMute}">${escapeXml(sub)}</text>
  ${g.svg}
  <text x="28" y="${H - 24}" font-family="${MONO}" font-size="10" fill="${PALETTE.inkFaint}">${escapeXml(footer || 'claude-rpc.com')}</text>
  ${legend(W - 66, H - 34, metric)}`;
  return frame(W, H, inner, `Claude Code ${what} heatmap`);
}

// ── stats card with heatmap (GET /stats/<h>.svg, `calendar --card`) ──────

function tile(x, y, w, value, label, color) {
  return `<g transform="translate(${x} ${y})">
    <rect x="2" y="3" width="${w}" height="64" fill="${PALETTE.ink}"/>
    <rect x="0" y="0" width="${w}" height="64" fill="${PALETTE.paper2}" stroke="${PALETTE.ink}" stroke-width="1.5"/>
    <rect x="0" y="0" width="5" height="64" fill="${color}"/>
    <text x="18" y="35" font-family="${DISPLAY}" font-size="26" font-weight="800" letter-spacing="-0.5" fill="${color}">${escapeXml(value)}</text>
    <text x="18" y="53" font-family="${MONO}" font-size="9.5" font-weight="700" letter-spacing="1.4" fill="${PALETTE.inkMute}">${escapeXml(label.toUpperCase())}</text>
  </g>`;
}

function fact(x, y, label, value) {
  return `<text x="${x}" y="${y}" font-family="${MONO}" font-size="9" font-weight="700" letter-spacing="1.3" fill="${PALETTE.inkFaint}">${escapeXml(label.toUpperCase())}</text>
  <text x="${x}" y="${y + 18}" font-family="${DISPLAY}" font-size="15" font-weight="700" fill="${PALETTE.ink}">${escapeXml(value)}</text>`;
}

// p: { handle, displayName, verified, githubUser, tokens, sessions, activeMs, streak } | null
// series: the merged daily series (or null — profile predates heatmap sync).
// kicker: the subtitle's lead-in ('Claude Code' live; the local card passes
// its own so a handle-less render doesn't read "Claude Code · Claude Code").
export function renderStatsCard(p, series, { metric = 'tokens', footer, kicker = 'Claude Code' } = {}) {
  metric = metricOf(metric);
  const W = 880;
  const has = !!p;
  const hasSeries = has && !!series && isDayKey(series.end);
  const name = clip(has ? (p.displayName || `@${p.handle}`) : 'claude-rpc', 30);
  const verified = has && !!p.verified;
  const what = metric === 'hours' ? 'hours' : 'tokens';
  const f = seriesFacts(series, metric);
  const sub = !has ? 'no public profile yet'
    : !hasSeries ? `${kicker} · heatmap fills in after the next profile sync`
    : `${kicker}${verified ? ' · verified' : ''} · ${f.activeDays} active days in the last year`;

  const dash = '—';
  const tw = 194, tg = 14, tx = 28, ty = 92;
  const tiles = [
    tile(tx,                 ty, tw, has ? fmtNum(p.tokens || 0) : dash,              'tokens',   PALETTE.rust),
    tile(tx + (tw + tg),     ty, tw, has ? fmtNum(p.sessions || 0) : dash,            'sessions', PALETTE.blue),
    tile(tx + (tw + tg) * 2, ty, tw, has ? fmtMinutes((p.activeMs || 0) / 60000) : dash, 'hours', PALETTE.amber),
    tile(tx + (tw + tg) * 3, ty, tw, has ? `${p.streak || 0}d` : dash,                'streak',   PALETTE.grass),
  ].join('');

  const gy = 204;
  const g = grid(28, gy, series, metric, { empty: !hasSeries });
  const fy = gy + g.height + 30;
  const facts = hasSeries ? [
    fact(58, fy, 'busiest day', f.busiest ? `${shortDate(f.busiest.date)} · ${fmtMetric(f.busiest.value, metric)}` : dash),
    fact(258, fy, `avg / active day`, fmtMetric(f.avgPerActiveDay, metric)),
    fact(428, fy, 'longest run', `${f.longestRun}d`),
    fact(568, fy, 'best weekday', f.bestWeekday || dash),
  ].join('') : '';
  const H = fy + 62;
  const gh = has && p.githubUser ? `github.com/${p.githubUser}` : 'claude-rpc.com';

  const inner = `
  ${spark(40, 45, 11, PALETTE.rust)}
  <text x="60" y="54" font-family="${DISPLAY}" font-size="27" font-weight="800" letter-spacing="-1" fill="${PALETTE.ink}">${escapeXml(name)}</text>
  <text x="61" y="74" font-family="${MONO}" font-size="12" fill="${PALETTE.inkMute}">${escapeXml(sub)}</text>
  ${verified ? verifiedStamp(W - 44, 46) : ''}
  ${tiles}
  <text x="28" y="${gy - 24}" font-family="${MONO}" font-size="9" font-weight="700" letter-spacing="1.4" fill="${PALETTE.inkMute}">${escapeXml(`${what} per day · last 12 months`.toUpperCase())}</text>
  ${g.svg}
  ${facts}
  ${legend(W - 66, fy + 4, metric)}
  <text x="28" y="${H - 20}" font-family="${MONO}" font-size="10" fill="${PALETTE.inkFaint}">${escapeXml(footer || gh)}</text>
  <text x="${W - 30}" y="${H - 20}" text-anchor="end" font-family="${MONO}" font-size="10" fill="${PALETTE.inkFaint}">claude-rpc.com</text>`;
  return frame(W, H, inner, `Claude Code stats: ${name}`);
}

// ── series merge (worker: one person, several machines) ──────────────────

// Sum several machines' series day-by-day onto one grid ending at `end`.
// Token and minute totals from different machines come from DIFFERENT
// transcripts, so summing is right (unlike calendar-day counts, which overlap).
export function mergeSeries(list, end, days = HEATMAP_DAYS) {
  const endMs = dayToMs(end);
  const tokens = new Array(days).fill(0), activeMin = new Array(days).fill(0);
  let any = false;
  for (const s of list) {
    if (!s || !isDayKey(s.end)) continue;
    any = true;
    const shift = Math.round((endMs - dayToMs(s.end)) / DAY_MS); // days s.end is before `end`
    for (const [src, dst] of [[s.tokens || [], tokens], [s.activeMin || [], activeMin]]) {
      for (let i = 0; i < src.length; i++) {
        const idx = days - 1 - shift - (src.length - 1 - i);
        if (idx >= 0 && idx < days) dst[idx] += Number(src[i]) || 0;
      }
    }
  }
  return any ? { end, tokens, activeMin } : null;
}
