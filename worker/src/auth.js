// Stateless signed tokens for the web login layer.
//
// Two token kinds, one mechanism: an HMAC-SHA256 signature over a JSON
// payload, both base64url'd and joined with '.'.
//   'state' — CSRF/state for the GitHub OAuth round-trip (10 min TTL)
//   'sess'  — a browser session ("this browser is GitHub user X", 7 days)
//
// Stateless on purpose: no session rows in KV, nothing to clean up, and a
// leaked SESSION_SECRET is rotated by setting a new secret (which invalidates
// every outstanding token at once). The payload carries only a public GitHub
// login — never an instanceId, which is the CLI's credential and must not
// reach the browser.

const te = new TextEncoder();
const td = new TextDecoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s) {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(data)));
}

// Constant-time string equality — both inputs are same-alphabet base64url.
function timingSafeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a signed token.
 * @param {'sess'|'state'} kind - Token kind; verification is kind-locked so a
 *   state token can never be replayed as a session.
 * @param {object} claims - Extra payload fields (e.g. { gh } or { ret }).
 * @param {string} secret - HMAC secret (worker secret SESSION_SECRET).
 * @param {number} ttlMs - Lifetime from `now`.
 * @param {number} [now] - Injectable clock for tests.
 */
export async function mintToken(kind, claims, secret, ttlMs, now = Date.now()) {
  const payload = JSON.stringify({ k: kind, ...claims, exp: now + ttlMs });
  const p64 = b64url(te.encode(payload));
  const sig = b64url(await hmacSign(secret, p64));
  return `${p64}.${sig}`;
}

/**
 * Verify a token: signature, kind, expiry. Returns the payload object or null.
 */
export async function verifyToken(token, kind, secret, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const want = b64url(await hmacSign(secret, parts[0]));
  if (!timingSafeEq(parts[1], want)) return null;
  let payload;
  try { payload = JSON.parse(td.decode(b64urlDecode(parts[0]))); } catch { return null; }
  if (!payload || payload.k !== kind) return null;
  if (!(Number(payload.exp) > now)) return null;
  return payload;
}

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const STATE_TTL_MS = 10 * 60 * 1000;
