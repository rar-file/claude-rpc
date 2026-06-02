// renderProfileCard — the embeddable GitHub profile stat card (v0.9).
// Pure function: aggregate → SVG string. We assert it produces valid-ish
// SVG with the headline lifetime numbers baked in.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderProfileCard } = await import('../src/profile.js');

const AGG = {
  activeMs: 412 * 3_600_000,
  sessions: 1247,
  userMessages: 8900,
  inputTokens: 1_000_000, outputTokens: 1_000_000,
  cacheReadTokens: 8_000_000, cacheWriteTokens: 0,
  linesAdded: 200_000, linesRemoved: 16_000, linesNet: 184_000,
  streak: 14, longestStreak: 31, daysSinceFirst: 142,
  estimatedCost: 1234,
  languages: { TypeScript: { files: 50, edits: 1450 }, Python: { files: 10, edits: 300 } },
};

test('renderProfileCard: returns a well-formed SVG', () => {
  const svg = renderProfileCard(AGG, { handle: 'rar-file' });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>\s*$/);
  assert.ok(svg.includes('Claude Code'));
  assert.ok(svg.includes('@rar-file'));
});

test('renderProfileCard: bakes in headline lifetime stats', () => {
  const svg = renderProfileCard(AGG, { handle: '@rar-file' });
  assert.ok(svg.includes('412h'), 'hours');
  assert.ok(svg.includes('1.2k') || svg.includes('1247'), 'sessions');
  assert.ok(svg.includes('14d'), 'current streak');
  assert.ok(svg.includes('TYPESCRIPT'), 'top language tag (uppercased)');
  assert.ok(svg.includes('+184.0k') || svg.includes('+184'), 'net lines');
});

test('renderProfileCard: handles an empty aggregate without throwing', () => {
  const svg = renderProfileCard({}, {});
  assert.match(svg, /^<svg /);
  assert.ok(svg.includes('on Claude Code'), 'falls back to generic handle');
});
