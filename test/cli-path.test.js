// cli-path: putting a packaged install's `claude-rpc` on PATH. The packaged exe
// lives in <config dir>/bin, which no shell searches, so without this every
// `claude-rpc <command>` setup prints came back "command not found".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// paths.js resolves homedir() at import: sandbox HOME first.
const HOME = mkdtempSync(join(tmpdir(), 'rpc-clipath-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.XDG_CONFIG_HOME = join(HOME, '.config');

const {
  pathHasDir,
  findOnPath,
  windowsPathScript,
  ensureCliOnPath,
  removeCliFromPath,
  pathExportHint,
  pickLinkDir,
  POSIX_LINK,
  POSIX_LINK_DIR,
} = await import('../src/cli-path.js');

const posix = process.platform !== 'win32';

function fakeExe() {
  const dir = mkdtempSync(join(HOME, 'exe-'));
  const exe = join(dir, 'claude-rpc');
  writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  return exe;
}
function clearLink() {
  rmSync(POSIX_LINK, { force: true });
}

test('pathHasDir: POSIX entries, trailing slashes, absent', () => {
  assert.equal(pathHasDir('/usr/bin:/home/u/.local/bin', '/home/u/.local/bin', 'linux'), true);
  assert.equal(pathHasDir('/usr/bin:/home/u/.local/bin/', '/home/u/.local/bin', 'linux'), true);
  assert.equal(pathHasDir('/usr/bin:/home/u/.local/binx', '/home/u/.local/bin', 'linux'), false);
  assert.equal(
    pathHasDir('/usr/bin:/Home/U/.local/bin', '/home/u/.local/bin', 'linux'),
    false,
    'case-sensitive on POSIX',
  );
  assert.equal(pathHasDir('', '/x', 'linux'), false);
  assert.equal(pathHasDir(undefined, '/x', 'darwin'), false);
});

test('pathHasDir: Windows is case-insensitive and ignores quotes, slashes, trailing backslash', () => {
  const dir = 'C:\\Users\\Me\\AppData\\Roaming\\claude-rpc\\bin';
  assert.equal(
    pathHasDir('C:\\Windows;c:\\users\\me\\appdata\\roaming\\CLAUDE-RPC\\bin\\', dir, 'win32'),
    true,
  );
  assert.equal(
    pathHasDir('"C:/Users/Me/AppData/Roaming/claude-rpc/bin";C:\\Windows', dir, 'win32'),
    true,
  );
  assert.equal(pathHasDir('C:\\Windows;;C:\\Tools', dir, 'win32'), false);
});

test('findOnPath: first hit wins; PATHEXT on Windows', () => {
  const files = new Set(['/b/claude-rpc', '/c/claude-rpc', 'C:\\tools\\claude-rpc.EXE']);
  const isFile = (p) => files.has(p);
  assert.equal(
    findOnPath('claude-rpc', { PATH: '/a:/b:/c', platform: 'linux', isFile }),
    '/b/claude-rpc',
  );
  assert.equal(findOnPath('claude-rpc', { PATH: '/a', platform: 'linux', isFile }), null);
  assert.equal(
    findOnPath('claude-rpc', {
      PATH: 'C:\\x;C:\\tools\\',
      PATHEXT: '.COM;.EXE',
      platform: 'win32',
      isFile,
    }),
    'C:\\tools\\claude-rpc.EXE',
  );
});

test('windowsPathScript: keeps the registry kind, escapes the dir, add vs remove', () => {
  const add = windowsPathScript("C:\\Users\\O'Neil\\claude-rpc\\bin", 'add');
  assert.match(add, /\$dir = 'C:\\Users\\O''Neil\\claude-rpc\\bin'/, 'single quotes doubled');
  assert.match(add, /DoNotExpandEnvironmentNames/, 'reads the raw, unexpanded value');
  assert.match(add, /GetValueKind\('Path'\)/, 'writes back with the original kind');
  assert.match(add, /'present'; exit 0/);
  assert.match(add, /\$key\.SetValue\('Path', \$new, \$kind\)/);
  // Must never write PATH through the .NET helper (it flattens REG_EXPAND_SZ).
  assert.doesNotMatch(add, /SetEnvironmentVariable\('Path'/i);
  const rm = windowsPathScript('C:\\x\\bin', 'remove');
  assert.match(rm, /-not \(/);
  assert.match(rm, /'absent'; exit 0/);
  assert.doesNotMatch(rm, /'present'/);
});

test('pathExportHint names the right shell file', () => {
  assert.match(pathExportHint('darwin'), /~\/\.zprofile$/);
  assert.match(pathExportHint('linux'), /~\/\.profile$/);
});

test('ensureCliOnPath: an existing claude-rpc on PATH is left alone', () => {
  // Real host semantics: Windows finds claude-rpc.exe via PATHEXT, and its
  // drive-letter paths can't go through a ':'-separated POSIX PATH.
  const dir = mkdtempSync(join(HOME, 'onpath-'));
  writeFileSync(join(dir, process.platform === 'win32' ? 'claude-rpc.exe' : 'claude-rpc'), 'x');
  const r = ensureCliOnPath({
    exe: fakeExe(),
    env: { PATH: dir, PATHEXT: '.EXE' },
    platform: process.platform,
  });
  assert.equal(r.status, 'already');
  assert.equal(r.cmd, 'claude-rpc');
});

test('ensureCliOnPath: CLAUDE_RPC_NO_PATH=1 skips and returns the full path', () => {
  const exe = fakeExe();
  const r = ensureCliOnPath({
    exe,
    env: { PATH: '/nonexistent', CLAUDE_RPC_NO_PATH: '1' },
    platform: 'linux',
  });
  assert.equal(r.status, 'skipped');
  assert.equal(r.cmd, `"${exe}"`);
});

test(
  'ensureCliOnPath (POSIX): links ~/.local/bin/claude-rpc; reports when that dir is off PATH',
  { skip: !posix },
  () => {
    clearLink();
    const exe = fakeExe();
    const off = ensureCliOnPath({ exe, env: { PATH: '/usr/bin' } });
    assert.equal(off.status, 'needs-path');
    assert.equal(readlinkSync(POSIX_LINK), exe);
    clearLink();
    const on = ensureCliOnPath({ exe, env: { PATH: `/usr/bin:${POSIX_LINK_DIR}` } });
    assert.equal(on.status, 'linked');
    assert.equal(on.cmd, 'claude-rpc');
    assert.equal(readlinkSync(POSIX_LINK), exe);
    // A re-run finds it through PATH and changes nothing.
    assert.equal(
      ensureCliOnPath({ exe, env: { PATH: `/usr/bin:${POSIX_LINK_DIR}` } }).status,
      'already',
    );
  },
);

test(
  'ensureCliOnPath (POSIX): never overwrites a real file or a live foreign link; replaces a dangling one',
  { skip: !posix },
  () => {
    const exe = fakeExe();
    mkdirSync(POSIX_LINK_DIR, { recursive: true });

    clearLink();
    writeFileSync(POSIX_LINK, 'install.sh copy');
    const file = ensureCliOnPath({ exe, env: { PATH: '/usr/bin' } });
    assert.equal(file.status, 'needs-path');
    assert.equal(lstatSync(POSIX_LINK).isSymbolicLink(), false, 'real file untouched');

    clearLink();
    const other = fakeExe();
    symlinkSync(other, POSIX_LINK);
    const foreign = ensureCliOnPath({ exe, env: { PATH: '/usr/bin' } });
    assert.equal(foreign.status, 'failed');
    assert.equal(readlinkSync(POSIX_LINK), other, 'live foreign link untouched');

    clearLink();
    symlinkSync(join(HOME, 'gone', 'claude-rpc'), POSIX_LINK);
    const dangling = ensureCliOnPath({ exe, env: { PATH: '/usr/bin' } });
    assert.equal(dangling.status, 'needs-path');
    assert.equal(readlinkSync(POSIX_LINK), exe, 'dangling link replaced');
  },
);

test('removeCliFromPath (POSIX): removes only our own link', { skip: !posix }, () => {
  const exe = fakeExe();
  clearLink();
  symlinkSync(exe, POSIX_LINK);
  assert.equal(removeCliFromPath({ exe }), true);
  assert.equal(existsSync(POSIX_LINK), false);

  const other = fakeExe();
  symlinkSync(other, POSIX_LINK);
  assert.equal(removeCliFromPath({ exe }), false);
  assert.equal(readlinkSync(POSIX_LINK), other);
  clearLink();
});

test(
  'pickLinkDir: ~/.local/bin when on PATH; macOS falls back to a writable /usr/local/bin',
  { skip: !posix },
  () => {
    const yes = () => true,
      no = () => false;
    assert.equal(
      pickLinkDir({ PATH: `/usr/local/bin:${POSIX_LINK_DIR}` }, 'darwin', yes),
      POSIX_LINK_DIR,
    );
    assert.equal(pickLinkDir({ PATH: '/usr/local/bin:/usr/bin' }, 'darwin', yes), '/usr/local/bin');
    assert.equal(
      pickLinkDir({ PATH: '/usr/local/bin:/usr/bin' }, 'darwin', no),
      POSIX_LINK_DIR,
      'not writable',
    );
    assert.equal(pickLinkDir({ PATH: '/usr/bin' }, 'darwin', yes), POSIX_LINK_DIR, 'not on PATH');
    assert.equal(
      pickLinkDir({ PATH: '/usr/local/bin:/usr/bin' }, 'linux', yes),
      POSIX_LINK_DIR,
      'Linux keeps ~/.local/bin',
    );
  },
);
