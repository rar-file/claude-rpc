// Puts a packaged install's `claude-rpc` on the shell's PATH.
//
// A packaged install (the release exe/binary, or the CLI the desktop app
// bundles) copies itself to CANONICAL_INSTALL_DIR (<config dir>/bin), which no
// shell searches. So every `claude-rpc <command>` that setup, doctor and the
// docs tell people to run came back "command not found" / "is not recognized".
// npm, Homebrew and install.sh installs are already on PATH and are left alone.
//
//   Windows      → append CANONICAL_INSTALL_DIR to the user PATH
//                  (HKCU\Environment), keeping the value's registry kind. New
//                  terminals see it; the one that ran setup doesn't.
//   macOS/Linux  → symlink claude-rpc → the canonical exe in ~/.local/bin (or,
//                  on macOS, /usr/local/bin when only that is on PATH). If
//                  neither is on PATH, say which line adds ~/.local/bin.
//
// CLAUDE_RPC_NO_PATH=1 skips all of it.

import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { CANONICAL_EXE, CANONICAL_INSTALL_DIR, CANONICAL_EXE_NAME } from './paths.js';

export const POSIX_LINK_DIR = join(homedir(), '.local', 'bin');
export const POSIX_LINK = join(POSIX_LINK_DIR, 'claude-rpc');

const isWin = (platform) => platform === 'win32';
const pathSep = (platform) => (isWin(platform) ? ';' : ':');

function normDir(p, platform) {
  let s = String(p)
    .trim()
    .replace(/^"(.*)"$/, '$1');
  if (isWin(platform)) return s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

// Is `dir` one of the entries of a PATH string? Case-insensitive on Windows,
// trailing separators and surrounding quotes ignored.
export function pathHasDir(pathValue, dir, platform = process.platform) {
  const want = normDir(dir, platform);
  return String(pathValue || '')
    .split(pathSep(platform))
    .some((e) => e.trim() && normDir(e, platform) === want);
}

function defaultIsFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// The first `name` a shell would run for this PATH (PATHEXT on Windows), or null.
export function findOnPath(
  name = 'claude-rpc',
  {
    PATH = process.env.PATH,
    PATHEXT = process.env.PATHEXT,
    platform = process.platform,
    isFile = defaultIsFile,
  } = {},
) {
  const win = isWin(platform);
  const exts = win
    ? String(PATHEXT || '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .filter(Boolean)
    : [''];
  for (const raw of String(PATH || '').split(pathSep(platform))) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    for (const ext of exts) {
      const p = `${dir.replace(/[\\/]+$/, '')}${win ? '\\' : '/'}${name}${ext}`;
      if (isFile(p)) return p;
    }
  }
  return null;
}

// PowerShell that adds `dir` to (or removes it from) the user PATH. It reads
// the raw, unexpanded value and writes it back with its original registry
// kind: [Environment]::SetEnvironmentVariable would flatten REG_EXPAND_SZ
// entries such as %USERPROFILE%\bin into literal text. Setting and clearing a
// throwaway variable through that API afterwards broadcasts WM_SETTINGCHANGE,
// so new terminals pick the change up. Prints present | absent | changed.
export function windowsPathScript(dir, action) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const same = `$_.TrimEnd('\\') -ieq $dir.TrimEnd('\\')`;
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$dir = ${q(dir)}`,
    `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)`,
    `$cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)`,
    `$kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }`,
    `$parts = @($cur -split ';' | Where-Object { $_ -ne '' })`,
    action === 'add'
      ? `if (@($parts | Where-Object { ${same} }).Count -gt 0) { 'present'; exit 0 }\n$new = (@($parts) + @($dir)) -join ';'`
      : `$keep = @($parts | Where-Object { -not (${same}) })\nif ($keep.Count -eq $parts.Count) { 'absent'; exit 0 }\n$new = $keep -join ';'`,
    `$key.SetValue('Path', $new, $kind)`,
    `$key.Close()`,
    `[Environment]::SetEnvironmentVariable('CLAUDE_RPC_PATH_SYNC', '1', 'User')`,
    `[Environment]::SetEnvironmentVariable('CLAUDE_RPC_PATH_SYNC', $null, 'User')`,
    `'changed'`,
  ].join('\n');
}

function runWindowsPathScript(dir, action) {
  const encoded = Buffer.from(windowsPathScript(dir, action), 'utf16le').toString('base64');
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  if (r.error) return { ok: false, detail: r.error.message };
  const out = String(r.stdout || '')
    .trim()
    .split(/\r?\n/)
    .pop();
  if (r.status !== 0 || !['present', 'absent', 'changed'].includes(out)) {
    return {
      ok: false,
      detail: String(r.stderr || r.stdout || `powershell exit ${r.status}`)
        .trim()
        .split(/\r?\n/)[0],
    };
  }
  return { ok: true, result: out };
}

const quote = (p) => `"${p}"`;

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

// Make `claude-rpc` resolvable for the packaged exe at `exe`. Returns
//   { status, cmd, detail, newTerminal }
// status: already | added / present (Windows user PATH, now / from an earlier
//         setup) | linked (~/.local/bin) | needs-path (~/.local/bin isn't on
//         PATH) | skipped | failed.
// cmd: what to type to run claude-rpc right now (the bare name when it
// resolves, else the full quoted path).
export function ensureCliOnPath({
  exe = CANONICAL_EXE,
  env = process.env,
  platform = process.platform,
} = {}) {
  const found = findOnPath('claude-rpc', { PATH: env.PATH, PATHEXT: env.PATHEXT, platform });
  if (found) return { status: 'already', cmd: 'claude-rpc', detail: found, newTerminal: false };
  if (env.CLAUDE_RPC_NO_PATH === '1') {
    return {
      status: 'skipped',
      cmd: quote(exe),
      detail: 'CLAUDE_RPC_NO_PATH=1',
      newTerminal: false,
    };
  }

  if (isWin(platform)) {
    const r = runWindowsPathScript(CANONICAL_INSTALL_DIR, 'add');
    if (!r.ok) return { status: 'failed', cmd: quote(exe), detail: r.detail, newTerminal: false };
    // 'present': an earlier setup added it; this terminal just predates that.
    return {
      status: r.result === 'present' ? 'present' : 'added',
      cmd: 'claude-rpc',
      detail: CANONICAL_INSTALL_DIR,
      newTerminal: true,
    };
  }

  // Where the link goes: ~/.local/bin when it's on PATH; on macOS, where it
  // usually isn't by default, /usr/local/bin when that is on PATH and writable
  // (Intel Homebrew, or an admin user); otherwise ~/.local/bin anyway, plus a
  // hint for adding it.
  const linkDir = pickLinkDir(env, platform);
  const link = join(linkDir, 'claude-rpc');
  const onPath = pathHasDir(env.PATH, linkDir, platform);
  try {
    mkdirSync(linkDir, { recursive: true });
    let st = null;
    try {
      st = lstatSync(link);
    } catch {
      /* nothing there yet */
    }
    if (st && !st.isSymbolicLink()) {
      // A real file, e.g. install.sh's copy of the binary. Never overwritten.
      return {
        status: onPath ? 'already' : 'needs-path',
        cmd: quote(exe),
        detail: `${link} (existing file, left alone)`,
        newTerminal: false,
      };
    }
    if (st && !(readlinkSync(link) === exe || samePath(link, exe))) {
      // Another link: replace it only when it's dangling (an old install).
      if (existsSync(link)) {
        return {
          status: 'failed',
          cmd: quote(exe),
          detail: `${link} points elsewhere — left alone`,
          newTerminal: false,
        };
      }
      unlinkSync(link);
      st = null;
    }
    if (!st) symlinkSync(exe, link);
  } catch (e) {
    return { status: 'failed', cmd: quote(exe), detail: e.message, newTerminal: false };
  }
  if (onPath) return { status: 'linked', cmd: 'claude-rpc', detail: link, newTerminal: false };
  return { status: 'needs-path', cmd: '~/.local/bin/claude-rpc', detail: link, newTerminal: false };
}

const MAC_SYSTEM_LINK_DIR = '/usr/local/bin';

function writable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function pickLinkDir(env = process.env, platform = process.platform, canWrite = writable) {
  if (pathHasDir(env.PATH, POSIX_LINK_DIR, platform)) return POSIX_LINK_DIR;
  if (
    platform === 'darwin' &&
    pathHasDir(env.PATH, MAC_SYSTEM_LINK_DIR, platform) &&
    canWrite(MAC_SYSTEM_LINK_DIR)
  ) {
    return MAC_SYSTEM_LINK_DIR;
  }
  return POSIX_LINK_DIR;
}

// The shell line that puts ~/.local/bin on PATH for new terminals.
export function pathExportHint(platform = process.platform) {
  const rc = platform === 'darwin' ? '~/.zprofile' : '~/.profile';
  return `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ${rc}`;
}

// Undo ensureCliOnPath: our claude-rpc link, or our user-PATH entry. Leaves
// anything that isn't ours alone. Returns true when something was removed.
export function removeCliFromPath({ exe = CANONICAL_EXE, platform = process.platform } = {}) {
  if (isWin(platform)) {
    if (!existsSync(join(CANONICAL_INSTALL_DIR, CANONICAL_EXE_NAME))) return false;
    const r = runWindowsPathScript(CANONICAL_INSTALL_DIR, 'remove');
    return r.ok && r.result === 'changed';
  }
  let removed = false;
  for (const link of [POSIX_LINK, join(MAC_SYSTEM_LINK_DIR, 'claude-rpc')]) {
    try {
      if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === exe) {
        unlinkSync(link);
        removed = true;
      }
    } catch {
      /* no link here */
    }
  }
  return removed;
}
