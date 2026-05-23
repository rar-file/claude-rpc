// Approximate Anthropic API pricing per million tokens, in USD.
// Numbers here are public list prices and change over time — they are NOT
// what your Claude Code subscription actually charges. Treat the resulting
// `costEstimate` as a usage-weighted rough order of magnitude, not a bill.
//
// To customize: edit this file and run `claude-rpc rescan`.

const PRICING = {
  // Opus 4.x family
  'opus-4':   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'opus-4-5': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'opus-4-6': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'opus-4-7': { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },

  // Sonnet 4.x family
  'sonnet-4':   { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'sonnet-4-5': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },

  // Haiku 4.x family
  'haiku-4':   { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  'haiku-4-5': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },

  // Generic fallbacks by tier.
  'opus':   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'sonnet': { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'haiku':  { input: 1.00,  output: 5.00,  cacheRead: 0.10, cacheWrite: 1.25 },
};

const DEFAULT = PRICING.sonnet;

const TIERS = new Set(['opus', 'sonnet', 'haiku']);

// Map a model id like "claude-opus-4-7-20251101" to a pricing key.
//
// The old implementation did `s.includes(key)` against the PRICING keys
// sorted by descending length, which silently mis-routed any future model
// id whose name contained one of those substrings out of order
// (e.g. `claude-sonneteer-x` matching `sonnet`). Now: split the id on `-`,
// find the first explicit tier token, then read the version digits that
// follow. Falls back from `tier-major-minor` → `tier-major` → tier generic
// → sonnet, in that order.
export function pricingKeyFor(modelId) {
  if (!modelId) return 'sonnet';
  const parts = String(modelId).toLowerCase().split('-');

  let tier = null;
  let tierIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (TIERS.has(parts[i])) { tier = parts[i]; tierIdx = i; break; }
  }
  if (!tier) return 'sonnet'; // unknown family — sonnet-class fallback

  const major = parts[tierIdx + 1];
  const minor = parts[tierIdx + 2];
  if (major && /^\d+$/.test(major)) {
    if (minor && /^\d+$/.test(minor)) {
      const k = `${tier}-${major}-${minor}`;
      if (PRICING[k]) return k;
    }
    const km = `${tier}-${major}`;
    if (PRICING[km]) return km;
  }
  return tier; // generic tier rates
}

export function ratesFor(modelId) {
  return PRICING[pricingKeyFor(modelId)] || DEFAULT;
}

// usage = { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
export function costFor({ model, usage }) {
  if (!usage) return 0;
  const r = ratesFor(model);
  const M = 1_000_000;
  return (
    ((usage.input_tokens || 0) * r.input)
    + ((usage.output_tokens || 0) * r.output)
    + ((usage.cache_read_input_tokens || 0) * r.cacheRead)
    + ((usage.cache_creation_input_tokens || 0) * r.cacheWrite)
  ) / M;
}

// Round to two decimal places for display, but keep sub-cent precision when
// the value is small enough that the rounded form would be "$0.00".
export function fmtCost(usd) {
  if (!usd) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  if (usd < 1000) return `$${Math.round(usd)}`;
  if (usd < 10_000) return `$${(usd / 1000).toFixed(2)}k`;
  return `$${(usd / 1000).toFixed(1)}k`;
}

export { PRICING };
