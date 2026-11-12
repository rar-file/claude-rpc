// Approximate Anthropic API pricing per million tokens, in USD.
// Numbers here are public list prices and change over time — they are NOT
// what your Claude Code subscription actually charges. Treat the resulting
// `costEstimate` as a usage-weighted rough order of magnitude, not a bill.
//
// To customize: edit this file and run `claude-rpc scan --force`.

const PRICING = {
  // List prices checked 2026-11-12 against platform.claude.com/docs/en/about-claude/pricing.

  // Fable family — Anthropic's frontier tier above Opus. 5.1 cut cache reads
  // 4x; 5.2 cut the base rates to $8/$40.
  'fable-5':   { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
  'fable-5-1': { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 },
  'fable-5-2': { input: 8.00,  output: 40.00, cacheRead: 0.20, cacheWrite: 10.00 },

  // Mythos (limited availability): Fable-tier capabilities and prices.
  'mythos-5':   { input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50 },
  'mythos-5-1': { input: 10.00, output: 50.00, cacheRead: 0.25, cacheWrite: 12.50 },
  'mythos-5-2': { input: 8.00,  output: 40.00, cacheRead: 0.20, cacheWrite: 10.00 },

  // 5.x generation. Haiku 5.5 uses its <=100K-token-prompt rates; past 100K
  // it's 5x, which a per-token table can't express — Claude Code prompts are
  // usually under that.
  'opus-5':     { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
  'opus-5-5':   { input: 4.00, output: 20.00, cacheRead: 0.20, cacheWrite: 5.00 },
  'sonnet-5':   { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.50 },
  'sonnet-5-5': { input: 2.00, output: 10.00, cacheRead: 0.10, cacheWrite: 2.50 },
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
};

const TIERS = new Set(['opus', 'sonnet', 'haiku', 'fable', 'mythos']);

// Known versions per tier, oldest → newest, derived from the table above so
// adding a row is the only step when a model ships.
const VERSIONS = {};
for (const key of Object.keys(PRICING)) {
  const [tier, major, minor = '0'] = key.split('-');
  (VERSIONS[tier] ||= []).push({ key, major: Number(major), minor: Number(minor) });
}
for (const list of Object.values(VERSIONS)) list.sort((a, b) => a.major - b.major || a.minor - b.minor);

// Generic tier keys (`opus`, `sonnet`, …) for ids that name a tier but no
// version. They alias the newest known row: an id we can't place is far more
// likely to be a current model than a retired one.
for (const [tier, list] of Object.entries(VERSIONS)) PRICING[tier] = PRICING[list.at(-1).key];

const DEFAULT = PRICING.sonnet;

// A version token is 1–2 digits; anything longer is a date stamp (20251101).
const isVer = (t) => typeof t === 'string' && /^\d{1,2}$/.test(t);

// Map a model id like "claude-opus-4-7-20251101" to a pricing key.
//
// Split the id on `-`, find the first explicit tier token (a whole token, so
// `claude-sonneteer-x` doesn't match `sonnet`), then read the version digits
// after it — or before it, for legacy ids like `claude-3-5-sonnet-20241022`.
//
// An exact row wins. Otherwise the nearest EARLIER known version of that tier
// prices it: a model released after this table was written (fable-5-3,
// opus-6) costs what its closest predecessor does, not what the oldest row or
// a years-old generic rate says. Versions older than every row use the oldest.
// No tier at all → sonnet-class fallback.
//
// Memoized per id string: the scanner calls this (directly and via costFor)
// for every assistant turn of every transcript, but a corpus only ever holds a
// handful of distinct model ids. PRICING is never mutated after load, so the
// cache can't go stale; the size cap just bounds a pathological transcript.
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

// Pull { tier, major, minor } out of a model id. tier is null when the id
// names no known family; major is null when it names a tier but no version.
function parseModel(modelId) {
  // Drop a context-window tag like `[1m]` (claude-opus-5-5[1m]) before parsing.
  const parts = String(modelId || '').toLowerCase().replace(/\[[^\]]*\]/g, '').split('-');
  const tierIdx = parts.findIndex((p) => TIERS.has(p));
  if (tierIdx === -1) return { tier: null, major: null, minor: 0 };
  let major = null;
  let minor = 0;
  if (isVer(parts[tierIdx + 1])) {
    major = Number(parts[tierIdx + 1]);
    if (isVer(parts[tierIdx + 2])) minor = Number(parts[tierIdx + 2]);
  } else {
    // Legacy order: claude-3-5-sonnet-… / claude-3-opus-…
    const before = parts.slice(0, tierIdx).filter(isVer);
    if (before.length) { major = Number(before[0]); minor = Number(before[1] || 0); }
  }
  return { tier: parts[tierIdx], major, minor };
}

function resolvePricingKey(modelId) {
  const { tier, major, minor } = parseModel(modelId);
  if (!tier) return 'sonnet';      // unknown family — sonnet-class fallback
  if (major === null) return tier; // tier named, no version — newest rates

  const known = VERSIONS[tier];
  let best = known[0];
  for (const v of known) {
    if (v.major < major || (v.major === major && v.minor <= minor)) best = v;
    else break;
  }
  return best.key;
}

// The model's own identity as a `tier-major[-minor]` key — what stats are
// bucketed and labelled by. Unlike pricingKeyFor this never folds a model into
// a neighbour: a release newer than the table (fable-5-3) is priced like
// fable-5-2 but still shows up as "Fable 5.3". Ids with no readable version
// fall back to the pricing key. Any key this returns is itself a valid input
// to pricingKeyFor/ratesFor.
const modelKeyCache = new Map();
export function modelKeyFor(modelId) {
  if (typeof modelId !== 'string') return pricingKeyFor(modelId);
  let k = modelKeyCache.get(modelId);
  if (k === undefined) {
    const { tier, major, minor } = parseModel(modelId);
    k = tier && major !== null ? `${tier}-${major}${minor ? `-${minor}` : ''}` : pricingKeyFor(modelId);
    if (modelKeyCache.size >= 256) modelKeyCache.clear();
    modelKeyCache.set(modelId, k);
  }
  return k;
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
