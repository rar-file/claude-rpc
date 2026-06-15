// Pure helpers for the public leaderboard / profile feature (hybrid model:
// anyone can appear with a self-chosen handle; a GitHub-linked profile earns a
// verified ✓ and ranks first). The networked pieces — the worker upsert, the
// gist-based verification, the board query — live in the worker and the daemon
// flush. These dependency-free bits are shared by the CLI and that flush, and
// are unit-tested in isolation.

// A handle is the public, URL-safe identity for a profile (→ /u/<handle>).
// Canonical form: lowercase, [a-z0-9-], 2–32 chars, no leading/trailing/double
// dashes. Returns the canonical handle, or null if it can't be made valid.
export function normalizeHandle(input) {
  if (!input || typeof input !== 'string') return null;
  const h = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-') // anything not alnum/dash → dash
    .replace(/-+/g, '-') // collapse runs of dashes
    .replace(/^-+|-+$/g, ''); // trim leading/trailing dashes
  if (h.length < 2 || h.length > 32) return null;
  return h;
}

// True only when `input` is already in canonical handle form.
export function isValidHandle(input) {
  return typeof input === 'string' && input.length > 0 && normalizeHandle(input) === input;
}

// Clamp a display name to something sane for a card: strip control characters,
// trim, bound the length. Returns null for empty input.
export function cleanDisplayName(input, max = 40) {
  if (!input || typeof input !== 'string') return null;
  // Strip control chars (C0/DEL/C1), zero-width, and bidi overrides so a name
  // can't visually corrupt or spoof the shared board. Denylist by code point -
  // CJK, emoji and accents still pass. Mirrored in the worker's cleanName.
  const ok = (c) => !(c < 32 || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff);
  const name = [...input].filter((ch) => ok(ch.codePointAt(0))).join('').trim().slice(0, max);
  return name || null;
}

// Normalize a GitHub username (used for the verified badge). GitHub usernames
// are 1–39 chars, alphanumeric or single hyphens, no leading/trailing hyphen.
export function normalizeGithubUser(input) {
  if (!input || typeof input !== 'string') return null;
  const u = input
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/.*$/, '');
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(u) ? u : null;
}

// The public identity fields a profile contributes to the board. Deliberately
// tiny — identity only; usage stats are sent as server-validated deltas
// separately, never trusted as a client-asserted total.
export function profileFields(profileCfg = {}) {
  return {
    handle: profileCfg.handle || null,
    displayName: profileCfg.displayName || null,
    githubUser: profileCfg.githubUser || null,
  };
}

// Is this profile config complete enough to publish to the board?
export function profileIsPublishable(profileCfg = {}) {
  return !!profileCfg.enabled && isValidHandle(profileCfg.handle);
}
