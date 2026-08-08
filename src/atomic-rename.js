// Windows can transiently refuse a rename onto an existing path — EPERM (or
// occasionally EBUSY/EACCES) — while something else briefly holds a handle
// on the destination: AV/Search-Indexer scans, or (confirmed live in CI) a
// directory being watched via fs.watch/ReadDirectoryChangesW, which every
// file this guards (state.json, the scan cache, aggregate.json) sits under.
// POSIX rename() is atomic and doesn't contend like this, so this is a
// no-op there. The lock is held single-digit milliseconds; a handful of
// immediate retries clears it without changing behavior anywhere else.
import { renameSync } from 'node:fs';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 20;

// Blocks the calling thread synchronously — the standard dependency-free way
// to sleep inside a sync call. Best-effort: if SharedArrayBuffer is ever
// unavailable, the retry loop just spins with no delay instead of failing.
function sleepSync(ms) {
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
