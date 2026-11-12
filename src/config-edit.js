// Config save helper for the settings page (src/server/settings.js). Pure —
// no fs — so test/config-edit.test.js can exercise it directly.
//
// The user's config.json holds OVERRIDES only. loadConfig deep-merges it over
// DEFAULT_CONFIG, and arrays REPLACE on that merge. The settings page therefore
// displays the merged view, but a save must write back only what the user
// changed. Writing the whole view would freeze every default into the file.
// Writing an untouched empty field would do worse: `presence.buttons: []`
// deletes the default button, because an array in the file replaces the default.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// Returns a copy of `raw` (the user's config.json as it is on disk now) with
// only the edits applied. `base` is what the page showed before the user
// touched anything, and `edited` is the same view after their edits. A key
// whose value is the same in both is left exactly as it is in `raw`: it isn't
// added, rewritten or removed. That also keeps keys another tool wrote while
// the page was open. A changed key is written. A changed array is written
// whole, which matches the merge rule. A key the page removed (a cleared
// field) is deleted, so the daemon falls back to its default.
export function applyEdits(raw, base, edited) {
  const out = isPlainObject(raw) ? structuredClone(raw) : {};
  patch(out, isPlainObject(base) ? base : {}, isPlainObject(edited) ? edited : {});
  return out;
}

function patch(target, base, edited) {
  for (const k of new Set([...Object.keys(base), ...Object.keys(edited)])) {
    // Never let a crafted key reach Object.prototype through the save path.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const a = base[k];
    const b = edited[k];
    if (deepEqual(a, b)) continue;
    if (b === undefined) { delete target[k]; continue; }
    if (isPlainObject(a) && isPlainObject(b)) {
      const had = Object.prototype.hasOwnProperty.call(target, k);
      if (!isPlainObject(target[k])) target[k] = {};
      patch(target[k], a, b);
      // Removing a key the file never had shouldn't leave an empty `{}` behind.
      if (!had && Object.keys(target[k]).length === 0) delete target[k];
      continue;
    }
    target[k] = structuredClone(b);
  }
}
