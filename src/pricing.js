// Approximate Anthropic API pricing per million tokens, in USD.
// Numbers here are public list prices and change over time — they are NOT
// what your Claude Code subscription actually charges. Treat the resulting
// `costEstimate` as a usage-weighted rough order of magnitude, not a bill.
//
// To customize: edit this file and run `claude-rpc rescan`.

const PRICING = {
  // Fable family — Anthropic's frontier tier above Opus. 5.1 cut cache reads 4x.
  'fable-5':   { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
  'fable-5-1': { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 },

  // Mythos (Project Glasswing only): Fable-tier capabilities and prices.
  'mythos-5':   { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
  'mythos-5-1': { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 },

  // 5.x generation (list prices checked 2026-10-14). Haiku 5.5 uses its
  // <=100K-token-prompt rates; past 100K it's 5x, which a per-token table
  // can't express — Claude Code prompts are usually under that.
  'opus-5':     { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'opus-5-5':   { input: 4.00, output: 20.00, cacheRead: 0.20, cacheWrite: 5.00 },
  'sonnet-5':   { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
  'sonnet-5-5': { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
  'haiku-5':    { input: 0.10, output: 0.50,  cacheRead: 0.01, cacheWrite: 0.125 },
  'haiku-5-5':  { input: 0.10, output: 0.50,  cacheRead: 0.01, cacheWrite: 0.125 },

  // Opus 4.x family. 4.0/4.1 launched at $15/$75; the list price dropped to
  // $5/$25 with Opus 4.5 and has held through 4.8.
  'opus-4':   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'opus-4-5': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'opus-4-6': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'opus-4-7': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'opus-4-8': { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },

  // Sonnet 4.x family
  'sonnet-4':   { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'sonnet-4-5': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'sonnet-4-6': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },

  // Haiku 4.x family
  'haiku-4':   { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
  'haiku-4-5': { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },

  // Generic fallbacks by tier. Opus uses the current-generation rates —
  // unknown/future opus ids are far more likely to be 4.5+ than 4.1-era.
  'fable':  { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
  'mythos': { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
  'opus':   { input: 5.00,  output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'sonnet': { input: 3.00,  output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  'haiku':  { input: 1.00,  output: 5.00,  cacheRead: 0.10, cacheWrite: 1.25 },
};

const DEFAULT = PRICING.sonnet;

const TIERS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'mythos']);

// Map a model id like "claude-opus-4-7-20251101" to a pricing key.
//
// The old implementation did `s.includes(key)` against the PRICING keys
// sorted by descending length, which silently mis-routed any future model
// id whose name contained one of those substrings out of order
// (e.g. `claude-sonneteer-x` matching `sonnet`). Now: split the id on `-`,
// find the first explicit tier token, then read the version digits that
// follow. Falls back from `tier-major-minor` → `tier-major` → tier generic
// → sonnet, in that order.
//
// Memoized per id string: the scanner calls this (directly and via costFor)
// for every assistant turn of every transcript, but a corpus only ever holds a
// handful of distinct model ids. PRICING is never mutated, so the cache can't
// go stale; the size cap just bounds a pathological transcript.
const keyCache = new Map();
export function pricingKeyFor(modelId) {
  if (typeof modelId !== 'string') return resolvePricingKey(modelId);
  let k = keyCache.get(modelId);
  if (k === undefined) {
    if (keyCache.size >= 256) keyCache.clear();
    keyCache.set(modelId, (k = resolvePricingKey(modelId)));
  }
  return k;
}

function resolvePricingKey(modelId) {
  if (!modelId) return 'sonnet';
  // Drop a context-window tag like `[1m]` (claude-opus-5-5[1m]) before parsing.
  const parts = String(modelId).toLowerCase().replace(/\[[^\]]*\]/g, '').split('-');

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
