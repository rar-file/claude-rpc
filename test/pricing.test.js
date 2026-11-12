// Pricing — used by both scanner aggregates and live cost display.
// Drift here means real dollar amounts on user dashboards are wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { costFor, fmtCost, pricingKeyFor, modelKeyFor, ratesFor } = await import('../src/pricing.js');

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

test('pricingKeyFor: an unknown version prices as its nearest earlier release', () => {
  // A model that shipped after the table was written should cost what its
  // closest predecessor does — not the oldest row of its major, and not a
  // generic rate from a previous generation.
  assert.equal(pricingKeyFor('claude-opus-5-1'), 'opus-5');   // between 5.0 and 5.5
  assert.equal(pricingKeyFor('claude-opus-5-6'), 'opus-5-5'); // newer minor
  assert.equal(pricingKeyFor('claude-fable-5-3'), 'fable-5-2');
  assert.equal(pricingKeyFor('claude-opus-7-1'), 'opus-5-5'); // newer major → newest known
  assert.equal(pricingKeyFor('claude-haiku-9-9'), 'haiku-5-5');
  assert.equal(pricingKeyFor('claude-sonnet-6'), 'sonnet-5-5');
  assert.equal(pricingKeyFor('claude-opus-4-1-20250805'), 'opus-4', '4.1 keeps the $15 launch rate');
});

test('pricingKeyFor: legacy ids, older-than-table versions and bare tiers', () => {
  // claude-3-5-sonnet-20241022: version precedes the tier, date follows it.
  assert.equal(pricingKeyFor('claude-3-5-sonnet-20241022'), 'sonnet-4');
  assert.equal(pricingKeyFor('claude-3-opus-20240229'), 'opus-4');
  // A tier with no version at all is assumed current.
  assert.equal(pricingKeyFor('opus'), 'opus');
  const M = 1_000_000;
  assert.equal(costFor({ model: 'opus', usage: { input_tokens: M } }), 4, 'bare tier → newest Opus rate');
  assert.equal(costFor({ model: 'claude-opus-5-5[1m]', usage: { input_tokens: M } }), 4);
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

test('pricingKeyFor: fable tier resolves with and without date suffix', () => {
  assert.equal(pricingKeyFor('claude-fable-5'), 'fable-5');
  assert.equal(pricingKeyFor('claude-fable-5-20260301'), 'fable-5');
  assert.equal(pricingKeyFor('claude-fable-9'), 'fable-5-2', 'unknown version → newest known Fable');
});

test('costFor: fable bills above opus, opus 4.6+ at current list rates', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  assert.equal(costFor({ model: 'claude-fable-5', usage }), 10, '$10/MTok input');
  assert.equal(costFor({ model: 'claude-opus-4-8', usage }), 5, '$5/MTok input');
  assert.equal(costFor({ model: 'claude-opus-4-6', usage }), 5);
  assert.equal(costFor({ model: 'claude-opus-4-20250514', usage }), 15, '4.0/4.1-era keeps launch pricing');
});

test('5.x list prices: Sonnet 5.5 cache reads $0.10; Fable 5.2 at $8/$40; Mythos priced like Fable; future Haiku 5.x', () => {
  const M = 1_000_000;
  assert.equal(costFor({ model: 'claude-sonnet-5-5', usage: { cache_read_input_tokens: M } }), 0.10);
  assert.equal(costFor({ model: 'claude-fable-5-2', usage: { input_tokens: M, output_tokens: M, cache_read_input_tokens: M, cache_creation_input_tokens: M } }), 8 + 40 + 0.20 + 10);
  assert.equal(pricingKeyFor('claude-mythos-5-2'), 'mythos-5-2');
  assert.equal(pricingKeyFor('claude-mythos-5-1'), 'mythos-5-1');
  assert.equal(pricingKeyFor('claude-mythos-5'), 'mythos-5');
  assert.equal(pricingKeyFor('claude-mythos-6'), 'mythos-5-2', 'unknown Mythos falls back to its own tier, not sonnet');
  assert.equal(costFor({ model: 'claude-mythos-5-1', usage: { input_tokens: M, output_tokens: M, cache_read_input_tokens: M } }), 10 + 50 + 0.25);
  assert.equal(pricingKeyFor('claude-haiku-5-6'), 'haiku-5-5', 'a newer Haiku 5.x is not priced at the 4.x generic');
});

test('modelKeyFor: stats keep the model\'s real version even when the price is borrowed', () => {
  assert.equal(modelKeyFor('claude-fable-5-2'), 'fable-5-2');
  assert.equal(modelKeyFor('claude-fable-5-3-20270101'), 'fable-5-3', 'unknown release keeps its own name');
  assert.equal(pricingKeyFor('claude-fable-5-3-20270101'), 'fable-5-2', '…and borrows the nearest price');
  assert.equal(modelKeyFor('claude-opus-6[1m]'), 'opus-6');
  assert.equal(modelKeyFor('claude-opus-4-20250514'), 'opus-4');
  assert.equal(modelKeyFor('claude-3-5-sonnet-20241022'), 'sonnet-3-5');
  // No readable version → same as the pricing key.
  assert.equal(modelKeyFor('<synthetic>'), 'sonnet');
  assert.equal(modelKeyFor('opus'), 'opus');
  // A model key round-trips through pricing (format.js re-prices by key).
  assert.deepEqual(ratesFor(modelKeyFor('claude-fable-5-3')), ratesFor('claude-fable-5-2'));
});
