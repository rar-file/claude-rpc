// Windows can transiently refuse a rename onto an existing path — EPERM (or
// occasionally EBUSY/EACCES) — while something else briefly holds a handle
// on the destination: AV/Search-Indexer scans, or (confirmed live in CI) a
// directory being watched via fs.watch/ReadDirectoryChangesW, which every
// file this guards (state.json, the scan cache, aggregate.json) sits under.
// POSIX rename() is atomic and doesn't contend like this, so this is a
// no-op there. The lock is held single-digit milliseconds; a handful of
// immediate retries clears it without changing behavior anywhere else.
import { createRequire } from 'node:module';

// require()d, not imported — on the hook hot path; see hook.js.
const require = createRequire(import.meta.url);
const { renameSync, writeFileSync, mkdirSync, existsSync, copyFileSync, unlinkSync } = require('node:fs');
const { dirname } = require('node:path');

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 20;

// Blocks the calling thread synchronously — the standard dependency-free way
// to sleep inside a sync call. Best-effort: if SharedArrayBuffer is ever
// unavailable, the retry loop just spins with no delay instead of failing.
// Shared with state.js's lock-retry loop.
export function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no SharedArrayBuffer — retry immediately instead */
  }
}

// Drop-in for fs.renameSync that tolerates Windows' transient rename locks.
// `platform`/`rename`/`sleep` are injectable so the retry loop is testable
// without a real Windows filesystem.
export function renameSyncRetry(src, dest, {
  platform = process.platform,
  rename = renameSync,
  sleep = sleepSync,
} = {}) {
  if (platform !== 'win32') return rename(src, dest);
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      return rename(src, dest);
    } catch (e) {
      lastErr = e;
      if (!RETRY_CODES.has(e.code)) throw e;
      sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

// Write `data` to `path` via a sibling tmp file + rename, so a reader (the
// daemon's config watcher, a concurrent CLI) never sees a half-written file.
// Creates the parent dir. Throws on failure, after removing the tmp file.
export function writeFileAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSyncRetry(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created / already renamed */ }
    throw e;
  }
}

// One-time move of a file from an old location to its new home: does nothing
// when `dest` already exists or there's nothing at `legacy`. rename() first;
// tmpdir is often a different filesystem (tmpfs), so EXDEV falls back to
// copy + unlink. Returns true when it adopted the legacy file. Never throws.
// `rename` is injectable so the EXDEV fallback is testable.
export function adoptLegacyFile(dest, legacy, { rename = renameSync } = {}) {
  try {
    if (!legacy || existsSync(dest) || !existsSync(legacy)) return false;
    mkdirSync(dirname(dest), { recursive: true });
    try {
      rename(legacy, dest);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      copyFileSync(legacy, dest);
      try { unlinkSync(legacy); } catch { /* copied; a stale legacy file is harmless */ }
    }
    return true;
  } catch {
    return false;
  }
}
