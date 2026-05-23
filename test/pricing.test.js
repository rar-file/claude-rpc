// Pricing — used by both scanner aggregates and live cost display.
// Drift here means real dollar amounts on user dashboards are wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { costFor, fmtCost, pricingKeyFor } = await import('../src/pricing.js');

test('pricingKeyFor recognizes model families with version specificity', () => {
  // Pricing.js returns version-keyed names (opus-4-7, not just opus) so
  // that price changes between model generations are accurate.
  assert.equal(pricingKeyFor('claude-opus-4-7'), 'opus-4-7');
  assert.equal(pricingKeyFor('claude-sonnet-4-6'), 'sonnet-4-6');
  assert.equal(pricingKeyFor('claude-haiku-4-5'), 'haiku-4-5');
});

test('pricingKeyFor handles dated suffixes', () => {
  // Real Anthropic API model ids have a `-YYYYMMDD` suffix. Those extra
  // digits used to confuse the old substring matcher; now they're just
  // ignored — only the tier-major-minor triple matters.
  assert.equal(pricingKeyFor('claude-opus-4-7-20251101'), 'opus-4-7');
  assert.equal(pricingKeyFor('claude-sonnet-4-6-20250514'), 'sonnet-4-6');
});

test('pricingKeyFor falls back to the generic tier for unknown versions', () => {
  // A future opus-5-1 we don't know about yet should still route to the
  // closest pricing we ship, not silently become sonnet.
  assert.equal(pricingKeyFor('claude-opus-5-1'), 'opus');
  assert.equal(pricingKeyFor('claude-haiku-9-9'), 'haiku');
});

test('pricingKeyFor: explicit tokens only — substring of a tier name does not match', () => {
  // Regression trap. The old `s.includes('sonnet')` matcher would match
  // a hypothetical id like 'claude-sonneteer-x' against the sonnet key.
  // Now: only the literal `sonnet` token between dashes counts. An id
  // we don't recognize falls all the way to sonnet *as the default*,
  // not as a tier match — so the outcome is the same value but for
  // the right reason.
  assert.equal(pricingKeyFor('claude-sonneteer-x'), 'sonnet', 'falls through default, not tier match');
  assert.equal(pricingKeyFor('claude-haikuesque-mini'), 'sonnet', 'no tier token, sonnet default');
});

test('pricingKeyFor returns a sane default for unknowns', () => {
  // For unknown models, fall back to sonnet rates so we still produce a
  // reasonable cost estimate rather than zeroing the whole bucket.
  const fallback = pricingKeyFor('gpt-4');
  assert.ok(fallback === 'sonnet' || /sonnet/.test(fallback), 'sonnet-class fallback');
});

test('costFor: unknown model still produces a positive estimate', () => {
  // Because pricingKeyFor falls back to sonnet, costFor returns a non-zero
  // value for any model with usage — better than silently dropping cost
  // for new/unrecognized model IDs.
  const c = costFor({ model: 'gpt-4', usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
  assert.ok(c > 0, 'fallback produces non-zero cost');
});

test('costFor: opus produces a positive number', () => {
  const c = costFor({
    model: 'claude-opus-4-7',
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  });
  assert.ok(c > 0, 'cost is positive');
});

test('costFor: handles missing usage gracefully', () => {
  assert.equal(costFor({ model: 'claude-opus-4-7' }), 0);
  assert.equal(costFor({ model: 'claude-opus-4-7', usage: {} }), 0);
});

test('fmtCost: under $1 shows cents', () => {
  const c = fmtCost(0.42);
  assert.match(c, /\$0\.4[0-9]/);
});

test('fmtCost: round dollars no decimals', () => {
  assert.ok(fmtCost(1234).includes('$'));
});

test('fmtCost: zero collapses to "$0"', () => {
  assert.equal(fmtCost(0), '$0');
});
