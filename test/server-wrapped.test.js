// /wrapped story markup (src/server/assets/wrapped.client.js), rendered by
// running the real browser script in a vm with a stub DOM and capturing the
// HTML it assigns to #app.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { fmtNum } from '../src/fmt.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'src', 'server', 'assets', 'wrapped.client.js'), 'utf8');

const PAYLOAD = {
  generatedAt: Date.UTC(2026, 9, 14),
  activeMs: 420 * 3_600_000,
  sessions: 1_500_000,
  prompts: 999_999,
  toolCalls: 12_000,
  tokens: 1_500,
  cachePct: 80,
  streak: 3,
  longestStreak: 21,
  daysSinceFirst: 200,
  topLanguage: { name: 'JavaScript', edits: 1234 },
  languages: [{ name: 'JavaScript', edits: 1234 }],
  hotspot: { name: 'server.js', count: 77, daysSinceLastEdit: 0 },
  peakHour: 14,
  peakWeekday: { name: 'Tuesday', hours: 3 },
  modelSplit: [
    { model: 'Opus 5.5', costPct: 0.8, tokenPct: 0.7 },
    { model: 'Sonnet 5.5', costPct: 0.2, tokenPct: 0.3 },
  ],
  linesAdded: 54_321,
  linesNet: 40_000,
  cost: 12,
  bestDay: { date: '2026-05-01', hours: 9 },
};

// The story's first innerHTML write is the full slide deck; mount() then
// throws on the stub DOM (no #story), which the script's own catch turns into
// an error message — irrelevant here.
async function renderStory(payload) {
  const writes = [];
  const app = {
    set innerHTML(v) {
      writes.push(String(v));
    },
  };
  vm.runInNewContext(SRC, {
    document: { getElementById: (id) => (id === 'app' ? app : null), addEventListener() {} },
    fetch: async () => ({ json: async () => payload }),
    navigator: {},
    performance: { now: () => 0 },
    requestAnimationFrame() {},
    setTimeout,
    clearTimeout,
    console,
  });
  for (let i = 0; i < 50 && !writes.length; i++) await delay(5);
  assert.ok(writes.length, 'the story rendered');
  return writes[0];
}

test('wrapped: no element carries two style attributes', async () => {
  const html = await renderStory(PAYLOAD);
  // The HTML parser keeps only the FIRST of duplicate attributes, so a
  // second style="" (font/clamp on the hotspot, the kicker's stagger slot)
  // was silently dropped.
  const dup = html.match(/<[^>]*\sstyle="[^"]*"[^>]*\sstyle="[^"]*"[^>]*>/g) || [];
  assert.deepEqual(dup, []);
  const hotspot = html.match(/<div class="big anim" style="([^"]*)">server\.js<\/div>/);
  assert.ok(hotspot, 'hotspot headline rendered');
  assert.match(hotspot[1], /font-family:'JetBrains Mono'/);
  assert.match(hotspot[1], /font-size:clamp\(/);
  assert.match(
    html,
    /<div class="kicker anim" style="--i:0">your models, by spend<\/div>/,
    'kicker animates first',
  );
});

test('wrapped: numbers use the shared fmtNum (same output as the web Wrapped)', async () => {
  const html = await renderStory(PAYLOAD);
  const cell = (k) =>
    (html.match(new RegExp(`<div class="cellk">${k}</div><div class="cellv[^"]*">([^<]*)</div>`)) ||
      [])[1];
  assert.equal(cell('Sessions'), fmtNum(PAYLOAD.sessions));
  assert.equal(cell('Sessions'), '1.50M');
  assert.equal(cell('Prompts'), fmtNum(PAYLOAD.prompts));
  assert.equal(cell('Prompts'), '1.00M', 'unit picked from the rounded value');
  assert.equal(cell('Tokens'), fmtNum(PAYLOAD.tokens));
});
