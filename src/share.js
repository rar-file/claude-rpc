// `claude-rpc share [week|month|year|all]` — one command to show people what
// you've been up to: saves the poster PNG for that window and copies a ready
// caption (your real numbers + a link back) to the clipboard. Nothing is
// posted anywhere; you paste it wherever you like.
//
//   claude-rpc share            last 7 days → ./claude-share-week.png + caption
//   claude-rpc share month      last 30 days
//   claude-rpc share --no-png   caption only
//
// The link is /get?ref=share so the worker can count what sharing brings in.

import { resolve, relative } from 'node:path';
import { c, fail, EX_USER_ERROR } from './ui.js';
import { fmtNum, fmtHours } from './fmt.js';

export const SHARE_URL = 'https://claude-rpc.com/get?ref=share';
const RANGES = ['week', 'month', 'year', 'all'];
const WINDOW = { week: 'last 7 days', month: 'last 30 days', year: 'last 12 months', all: 'all time' };

export function parseShareArgs(argv) {
  const o = { range: 'week', png: true, path: null, copy: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-png') o.png = false;
    else if (a === '--no-copy') o.copy = false;
    else if (a === '--png' || a === '--out') {
      const n = argv[i + 1];
      if (!n || n.startsWith('-')) return { error: `${a} needs a path` };
      o.path = n; i++;
    } else if (RANGES.includes(a)) o.range = a;
    else return { error: `unknown option ${a}` };
  }
  return o;
}

// The caption: real numbers for the window, skipping any that are zero so a
// quiet week doesn't read "0 prompts". `r` is card.js rollup() output.
export function shareCaption(r, { range = 'week', streak = 0 } = {}) {
  const bits = [];
  if (r.activeMs > 0) bits.push(`${fmtHours(r.activeMs)} with Claude Code`);
  if (r.userMessages > 0) bits.push(`${fmtNum(r.userMessages)} prompts`);
  if (r.tokens > 0) bits.push(`${fmtNum(r.tokens)} tokens`);
  if (r.linesAdded > 0) bits.push(`+${fmtNum(r.linesAdded)} lines`);
  if (streak > 1) bits.push(`${streak}-day streak`);
  const head = bits.length ? `My ${WINDOW[range]}: ${bits.join(' · ')}.` : `Tracking my Claude Code sessions.`;
  return `${head}\nLive on my Discord profile with claude-rpc → ${SHARE_URL}`;
}

// ctx: { aggregate(), copy(text) → tool|null }
export async function runShare(argv, ctx) {
  const o = parseShareArgs(argv);
  if (o.error) return fail(o.error, { hint: 'claude-rpc help share', code: EX_USER_ERROR });
  const aggregate = ctx.aggregate();
  const { rollup, renderCard } = await import('./card.js');
  const caption = shareCaption(rollup(aggregate, o.range), { range: o.range, streak: aggregate?.streak || 0 });

  console.log('');
  if (o.png) {
    const path = resolve(o.path || `claude-share-${o.range}.png`);
    try {
      const { svgToPng } = await import('./png.js');
      const r = await svgToPng(renderCard(aggregate, { range: o.range }), path);
      console.log(`  ${c.green}✓${c.reset}  saved ${c.cyan}${relative(process.cwd(), path) || path}${c.reset}  ${c.dim}(${r.width}×${r.height}) — drag it into Discord, X or LinkedIn${c.reset}`);
    } catch (e) {
      // No PNG backend is not fatal — the caption is the important half.
      console.log(`  ${c.yellow}!${c.reset}  ${c.dim}no image: ${e.message}${e.hint ? ` — ${e.hint}` : ''}${c.reset}`);
    }
  }
  console.log('');
  for (const line of caption.split('\n')) console.log(`    ${line}`);
  console.log('');
  const tool = o.copy ? await ctx.copy(caption) : null;
  if (tool) console.log(`  ${c.magenta}⧉${c.reset}  ${c.dim}caption copied — paste it with the image${c.reset}`);
  else if (o.copy) console.log(`  ${c.dim}no clipboard tool found — copy the caption above${c.reset}`);
  console.log('');
}
