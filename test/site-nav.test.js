// Every site page must carry the same top bar, stamped from
// scripts/sync-nav.mjs. Fails when a page is edited by hand or a new page
// forgets the markers — the drift that left half the site with no nav.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
const { PAGES, LINKS, syncPage, navHtml } = await import('../scripts/sync-nav.mjs');
const site = new URL('../site/', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('site nav: every listed page is in sync with the template', () => {
  for (const [rel, cfg] of Object.entries(PAGES)) {
    const html = readFileSync(new URL(rel, site), 'utf8');
    assert.equal(syncPage(html, cfg, version), html, `${rel} drifted — run: node scripts/sync-nav.mjs`);
  }
});

test('site nav: no html page is left out (promo is the one chromeless exception)', () => {
  const pages = [
    ...readdirSync(site).filter((f) => f.endsWith('.html')),
    ...readdirSync(new URL('blog/', site)).filter((f) => f.endsWith('.html')).map((f) => `blog/${f}`),
  ];
  const missing = pages.filter((p) => !(p in PAGES) && p !== 'promo.html');
  assert.deepEqual(missing, [], 'add new pages to PAGES in scripts/sync-nav.mjs');
});

test('site nav: marks exactly the active section', () => {
  const html = navHtml({ active: 'docs' }, '9.9.9');
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /href="\/docs" aria-current="page"/);
  assert.equal((navHtml({ active: null }, '9.9.9').match(/aria-current/g) || []).length, 0);
  assert.equal(LINKS.length, (html.match(/<a href=/g) || []).length);
});
