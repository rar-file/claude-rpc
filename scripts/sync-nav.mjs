#!/usr/bin/env node
// Stamps the ONE site top bar into every page of site/. The bar lives here and
// only here: each page carries it between <!-- site-nav --> markers, and this
// script rewrites that span (plus the /nav.css link) from the template below.
//
//   node scripts/sync-nav.mjs          rewrite pages in place
//   node scripts/sync-nav.mjs --check  exit 1 if any page has drifted (CI test)
//
// Adding a page: add it to PAGES with the section it belongs to, put an empty
// `<!-- site-nav --><!-- /site-nav -->` right after <body>, run this.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');

export const LINKS = [
  ['docs', '/docs', 'docs'],
  ['leaderboard', '/leaderboard', 'leaderboard'],
  ['squads', '/squads', 'squads'],
  ['community', '/community', 'community'],
  ['wrapped', '/wrapped', 'wrapped'],
  ['posts', '/blog', 'posts'],
  ['github', 'https://github.com/rar-file/claude-rpc', 'github ↗'],
];

// page → { active: LINKS key or null, overlay: float over a full-screen page }
export const PAGES = {
  'index.html':       { active: null },
  'docs.html':        { active: 'docs' },
  'leaderboard.html': { active: 'leaderboard' },
  'u.html':           { active: 'leaderboard' },
  'squads.html':      { active: 'squads' },
  'squad.html':       { active: 'squads' },
  'link.html':        { active: 'leaderboard' },
  'community.html':   { active: 'community' },
  'wrapped.html':     { active: 'wrapped', overlay: true },
  'blog.html':        { active: 'posts' },
  'blog/how-it-works.html': { active: 'posts' },
  'blog/now-a-plugin.html': { active: 'posts' },
  'blog/ship-week.html':    { active: 'posts' },
  'blog/three-weeks.html':  { active: 'posts' },
  'blog/zero-deps.html':    { active: 'posts' },
  '404.html':         { active: null },
  // promo.html is deliberately absent: it's a chromeless 16:9 stage for
  // screen-recording the promo video, not a page people navigate.
};

const START = '<!-- site-nav -->';
const END = '<!-- /site-nav -->';
const CSS = '<link rel="stylesheet" href="/nav.css" />';

export function navHtml({ active = null, overlay = false } = {}, version) {
  const links = LINKS.map(([key, href, label]) => {
    const cur = key === active ? ' aria-current="page"' : '';
    return `      <a href="${href}"${cur}>${label}</a>`;
  }).join('\n');
  return `${START}
<nav class="site-nav${overlay ? ' sn-overlay' : ''}" aria-label="site">
  <div class="sn-in">
    <a class="sn-brand" href="/"><img src="/img/favicon.png" alt="" width="26" height="26" /> claude-rpc <span class="sn-ver" id="nav-version">v${version}</span></a>
    <div class="sn-links">
${links}
    </div>
    <a class="sn-cta" href="/#download">install →</a>
  </div>
</nav>
${END}`;
}

export function syncPage(html, cfg, version) {
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error('missing <!-- site-nav --> markers');
  let out = html.slice(0, a) + navHtml(cfg, version) + html.slice(b + END.length);
  if (!out.includes(CSS)) out = out.replace('</head>', `${CSS}\n</head>`);
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const drift = [];
  for (const [rel, cfg] of Object.entries(PAGES)) {
    const p = join(SITE, rel);
    const before = readFileSync(p, 'utf8');
    const after = syncPage(before, cfg, version);
    if (after === before) continue;
    if (check) drift.push(rel);
    else { writeFileSync(p, after); console.log(`  synced ${rel}`); }
  }
  if (check && drift.length) {
    console.error(`site nav out of sync in: ${drift.join(', ')}\nrun: node scripts/sync-nav.mjs`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
