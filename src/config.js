// Config loader. One place that knows how to:
//
//   1. Read the user's config.json from disk.
//   2. Deep-merge it over DEFAULT_CONFIG so the user file only needs to
//      hold *overrides* (a fresh user file is two lines: clientId and
//      maybe appName).
//   3. Survive bad JSON / missing files / wrong types without crashing.
//      Bad input logs a one-line warning and falls back to defaults.
//      Critical for the daemon — an Electron-GUI mid-edit save used to
//      hard-exit it via daemon.js's `process.exit(1)`. No more.
//
// Merge rule: plain objects deep-merge, arrays REPLACE. Arrays-as-deep-
// merge is rarely what anyone wants (a user rotation array becomes a
// spliced franken-array of theirs + defaults). Replacing matches what
// you'd expect from "I set this, it's mine."
//
// All callers (daemon, server/api, tui, cli) should go through
// `loadConfig()` rather than reading CONFIG_PATH directly.

import { readFileSync, existsSync } from 'node:fs';
import { CONFIG_PATH } from './paths.js';
import { DEFAULT_CONFIG } from './default-config.js';

// "Has the user run setup?" — a separate signal from `loadConfig` because
// loadConfig now always returns merged defaults (the daemon needs them
// even if the file isn't there yet). Callers that want to distinguish
// "never been set up" from "everything default" check this instead.
export function hasUserConfig(path = CONFIG_PATH) {
  return existsSync(path);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Deep-merge `over` onto `base`. Plain objects merge recursively; arrays
// and primitives from `over` replace whatever was in `base`. Returns a
// fresh object — neither input is mutated. Used for layering user config
// over DEFAULT_CONFIG and (later) per-project overrides over user config.
export function mergeConfig(base, over) {
  if (over === undefined || over === null) return structuredClone(base);
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over);
  const out = {};
  const keys = new Set([...Object.keys(base), ...Object.keys(over)]);
  for (const k of keys) {
    const a = base[k];
    const b = over[k];
    if (b === undefined) {
      out[k] = structuredClone(a);
    } else if (isPlainObject(a) && isPlainObject(b)) {
      out[k] = mergeConfig(a, b);
    } else {
      out[k] = structuredClone(b);
    }
  }
  return out;
}

// Read + merge. `onError(message)` is called when the user config can't
// be parsed — caller decides whether to log to stdout, daemon.log, or
// nothing. Returning the merged-defaults object is the contract: never
// throw, never exit. Worst case we render with shipped defaults.
//
// path defaults to CONFIG_PATH so all daemon-like callers can drop the
// `readFileSync(CONFIG_PATH, ...)` boilerplate.
export function loadConfig({ path = CONFIG_PATH, onError } = {}) {
  if (!existsSync(path)) {
    return mergeConfig(DEFAULT_CONFIG, {});
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if (onError) onError(`config read failed at ${path}: ${e.message} — falling back to defaults`);
    return mergeConfig(DEFAULT_CONFIG, {});
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    if (onError) onError(`config parse failed at ${path}: ${e.message} — falling back to defaults`);
    return mergeConfig(DEFAULT_CONFIG, {});
  }
  if (!isPlainObject(parsed)) {
    if (onError) onError(`config at ${path} is not an object — falling back to defaults`);
    return mergeConfig(DEFAULT_CONFIG, {});
  }
  return mergeConfig(DEFAULT_CONFIG, parsed);
}
