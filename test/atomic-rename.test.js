// Unit coverage for the Windows transient-rename-lock retry (src/atomic-rename.js).
// Confirmed live in CI: renaming state.json on windows-latest intermittently
// threw EPERM — see the commit that added this file. rename/sleep are
// injected so the retry loop is testable without a real Windows filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameSyncRetry } from '../src/atomic-rename.js';

test('renameSyncRetry: passes straight through on non-Windows, no retry machinery involved', () => {
  const calls = [];
  const rename = (src, dest) => calls.push({ src, dest });
  renameSyncRetry('a.tmp', 'a', { platform: 'linux', rename, sleep: () => { throw new Error('must not sleep on posix'); } });
  assert.deepEqual(calls, [{ src: 'a.tmp', dest: 'a' }]);
});

test('renameSyncRetry: on win32, retries a transient EPERM and succeeds', () => {
  let attempts = 0;
  const sleeps = [];
  const rename = () => {
    attempts++;
    if (attempts < 3) {
      const e = new Error('operation not permitted');
      e.code = 'EPERM';
      throw e;
    }
  };
  renameSyncRetry('a.tmp', 'a', { platform: 'win32', rename, sleep: (ms) => sleeps.push(ms) });
  assert.equal(attempts, 3, 'retried until the transient lock cleared');
  assert.equal(sleeps.length, 2, 'slept between the two failed attempts, not after the success');
});

test('renameSyncRetry: on win32, EBUSY and EACCES are retried too', () => {
  for (const code of ['EBUSY', 'EACCES']) {
    let attempts = 0;
    const rename = () => {
      attempts++;
      if (attempts < 2) {
        const e = new Error(code);
        e.code = code;
        throw e;
      }
    };
    renameSyncRetry('a.tmp', 'a', { platform: 'win32', rename, sleep: () => {} });
    assert.equal(attempts, 2, `${code} is retried, not thrown immediately`);
  }
});

test('renameSyncRetry: on win32, a non-transient error throws immediately without retrying', () => {
  let attempts = 0;
  const rename = () => {
    attempts++;
    const e = new Error('no such file or directory');
    e.code = 'ENOENT';
    throw e;
  };
  assert.throws(
    () => renameSyncRetry('a.tmp', 'a', { platform: 'win32', rename, sleep: () => { throw new Error('must not sleep on a non-retryable error'); } }),
    /no such file/,
  );
  assert.equal(attempts, 1, 'ENOENT is not in the retry set — fails fast');
});

test('renameSyncRetry: on win32, exhausting all attempts throws the last error', () => {
  let attempts = 0;
  const rename = () => {
    attempts++;
    const e = new Error('operation not permitted');
    e.code = 'EPERM';
    throw e;
  };
  assert.throws(
    () => renameSyncRetry('a.tmp', 'a', { platform: 'win32', rename, sleep: () => {} }),
    /operation not permitted/,
  );
  assert.ok(attempts >= 5, `gives up after a bounded number of attempts (got ${attempts})`);
});
