// Paths for hook commands that every hook shell parses the same way.
//
// Claude Code runs hook commands through whatever shell the user has: sh /
// Git Bash, cmd, or PowerShell (issue #48). A line that STARTS with a quoted
// string is an expression in PowerShell, not a command, so the old
// `"C:/Program Files/nodejs/node.exe" "…/hook.js" Stop` form failed with
// "Unexpected token" on every event. PowerShell needs `& "…"`, which sh
// rejects. The shape all three accept is an unquoted path, so on Windows a
// path with spaces or shell metacharacters is swapped for its 8.3 short name
// (C:/PROGRA~1/nodejs/node.exe). Only when that isn't possible (8.3 names
// disabled on the volume) does it fall back to quoting.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Characters no hook shell treats specially in a bare word.
const BARE_SAFE = /^[\w:./\\~+-]+$/;
const shortCache = new Map();

// 8.3 short form of an existing Windows path via cmd's %~s modifier, or null.
// `/c` without `/s` keeps cmd from stripping the quotes around the path.
export function shortPathWin(p, { spawn = spawnSync, exists = existsSync } = {}) {
  if (shortCache.has(p)) return shortCache.get(p);
  let out = null;
  if (exists(p)) {
    try {
      const r = spawn('cmd.exe', ['/d', '/c', `for %I in ("${p.replace(/\//g, '\\')}") do @echo %~sI`], {
        encoding: 'utf8', timeout: 4000, windowsHide: true, windowsVerbatimArguments: true,
      });
      const line = String(r.stdout || '').trim().split(/\r?\n/).pop();
      if (r.status === 0 && line) out = line.replace(/\\/g, '/');
    } catch { /* cmd unavailable — caller quotes */ }
  }
  shortCache.set(p, out);
  return out;
}

// One argv word of a hook command. POSIX keeps the long-standing quoted form
// (sh is the only hook shell there). Windows: bare when safe, else the short
// path, else quoted as a last resort.
export function hookWord(p, { platform = process.platform, shortPath = shortPathWin } = {}) {
  const fwd = String(p).replace(/\\/g, '/');
  if (platform !== 'win32') return `"${fwd}"`;
  if (BARE_SAFE.test(fwd)) return fwd;
  const short = shortPath(fwd);
  return short && BARE_SAFE.test(short) ? short : `"${fwd}"`;
}
