// "Is Claude Code actually running?" — process-level liveness detection.
//
// The daemon's only passive signals for "Claude Code is open" were hook
// freshness (state.lastActivity) and transcript mtimes (findLiveSessions).
// Both go quiet the moment the user stops typing: a session left open at the
// prompt writes NOTHING to disk, so after staleSessionMin the daemon concluded
// "Claude Code not running" and cleared the card — even with idleWhenOpen:true,
// whose staleMs backstop exists precisely because transcript silence was
// previously indistinguishable from a closed terminal. Asking the OS whether a
// Claude Code process exists removes that ambiguity: alive → the card stays up
// as 'idle' indefinitely; gone → the existing stale paths clear it.
//
// Detection is deliberately conservative about what counts as Claude Code:
//   - a process literally named `claude` / `claude.exe` (native installer)
//   - a runtime (node/bun/deno) whose command line points into the
//     `@anthropic-ai/claude-code` package (npm/npx installs)
//   - a binary run from the native installer's version store
//     (~/.local/share/claude/versions/<v>)
// It must NOT match claude-rpc itself (this daemon is `node .../claude-rpc/
// src/daemon.js` — a bare /claude/ substring test would make the daemon see
// itself as Claude Code and the card would never clear). Every pattern below
// therefore requires a word boundary right after "claude".
//
// Adopted from the Teksya fork's groundwork (fork commit 46b62a5).
import { execFile } from 'node:child_process';

// One process-table query per call is the whole cost model; the daemon calls
// on a slow timer (see CLAUDE_PROC_POLL_MS in daemon.js), so no caching here.
const EXEC_TIMEOUT_MS = 15_000;

// Does this (name, command line) pair look like a Claude Code process?
// Exported for tests. `name` is the executable name where the platform gives
// us one (Win32_Process.Name / ps comm); `cmdline` is the full command line.
export function looksLikeClaudeCode(name, cmdline) {
  const n = String(name || '').toLowerCase();
  const c = String(cmdline || '').replace(/\\/g, '/').toLowerCase();
  // The Claude DESKTOP app's binary is ALSO named claude(.exe) — Windows
  // installs under …/AnthropicClaude/, macOS ships as Claude.app, Linux builds
  // as …/claude-desktop/claude-desktop. It is not Claude Code; matching it
  // would pin the card up whenever the chat app is open. Path check comes
  // first so nothing below can re-admit it.
  if (c.includes('anthropicclaude') || c.includes('claude.app/') || c.includes('/claude-desktop')) {
    return false;
  }
  // npm / npx install: node …/node_modules/@anthropic-ai/claude-code/cli.js
  if (c.includes('@anthropic-ai/claude-code/')) return true;
  // Native-install version store: …/.local/share/claude/versions/<v>
  if (c.includes('/share/claude/versions/')) return true;
  // A command-line token that IS `claude` / `claude.exe` — bare (as typed in a
  // shell, argv[0] preserved) or as the tail of a path. The boundary required
  // right after "claude" is what keeps claude-rpc from matching. `--flag=value`
  // tokens are dropped first: Electron children carry a profile path like
  // --user-data-dir=/home/o/.config/Claude, which is a directory, not a binary.
  const tokens = c.replace(/(^|\s)--?[\w-]+=("[^"]*"|\S*)/g, '$1');
  if (/(^|[/"'])claude(\.exe)?["']?(\s|$)/.test(tokens)) return true;
  // No command line to inspect (platform hid it) — fall back to the process
  // name alone. Only safe here because the desktop-app exclusion above could
  // not run; a bare-name match is still far likelier Code than the chat app
  // being unreadable.
  if (!c && (n === 'claude' || n === 'claude.exe')) return true;
  return false;
}

function execText(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

// Resolve to true/false when the platform answered, null when the query itself
// failed (missing tool, timeout, unsupported platform) — null means "unknown"
// and callers must fall back to the old transcript-only behavior. Never throws.
export async function detectClaudeProcess() {
  if (process.platform === 'win32') {
    // Only the names that can host Claude Code — a full process dump with
    // command lines is much slower than this filtered CIM query.
    const script = "Get-CimInstance Win32_Process -Filter \"Name='claude.exe' OR Name='node.exe' OR Name='bun.exe' OR Name='deno.exe'\" | ForEach-Object { $_.Name + [char]9 + $_.CommandLine }";
    const out = await execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (out === null) return null;
    for (const line of out.split('\n')) {
      const tab = line.indexOf('\t');
      const name = tab === -1 ? line.trim() : line.slice(0, tab).trim();
      const cmd = tab === -1 ? '' : line.slice(tab + 1);
      if (looksLikeClaudeCode(name, cmd)) return true;
    }
    return false;
  }
  // macOS / Linux. comm is the executable name (first token); args follows.
  const out = await execText('ps', ['-eo', 'comm=,args=']);
  if (out === null) return null;
  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sp = trimmed.indexOf(' ');
    const comm = sp === -1 ? trimmed : trimmed.slice(0, sp);
    const args = sp === -1 ? '' : trimmed.slice(sp + 1);
    // comm may be a path on some ps builds — compare its basename.
    const base = comm.slice(comm.lastIndexOf('/') + 1);
    if (looksLikeClaudeCode(base, args)) return true;
  }
  return false;
}
