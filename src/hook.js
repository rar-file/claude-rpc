#!/usr/bin/env node
import { readFileSync, appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { updateState, resetState, pushUnique, shortFile } from './state.js';
import { detectLastCommitSubject, detectGitBranch } from './git.js';
import { EVENTS_LOG_PATH } from './paths.js';
import { loadConfig } from './config.js';
import { ensureDaemonRunning } from './ensure-daemon.js';

// Precedence when a command ships more than one way (`git commit && git push`
// → push). Highest first.
const SHIP_PRECEDENCE = ['push', 'commit', 'pr', 'issue', 'tag'];

// Tokenize one command segment the way a shell roughly would for our purposes:
// strip leading env assignments (FOO=bar) and sudo/time wrappers, drop the path
// from the leading binary (/usr/bin/git → git), lowercase it.
function tokenizeSegment(seg) {
  const stripped = seg.replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '').trim();
  let toks = stripped.split(/\s+/).filter(Boolean);
  while (toks.length && (toks[0] === 'sudo' || toks[0] === 'time')) toks = toks.slice(1);
  if (toks.length) {
    const slash = toks[0].lastIndexOf('/');
    if (slash !== -1) toks[0] = toks[0].slice(slash + 1);
    toks[0] = toks[0].toLowerCase();
  }
  return toks;
}

// First real git subcommand, skipping global flags and their values
// (`git -C /repo -c k=v push` → push).
function gitSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-C' || a === '-c') { i++; continue; } // flag that takes a value
    if (a.startsWith('-')) continue;
    return a.toLowerCase();
  }
  return null;
}

// First two gh positionals (noun, verb), skipping global flags so the canonical
// targeted form `gh -R owner/repo pr create` still classifies. -R/--repo take a
// value; other globals here don't precede a create, so skipping the rest is safe.
function ghSubcommand(args) {
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-R' || a === '--repo') { i++; continue; } // flag that takes a value
    if (a.startsWith('-')) continue;
    pos.push(a.toLowerCase());
    if (pos.length === 2) break;
  }
  return { noun: pos[0], verb: pos[1] };
}

function shipKindForSegment(seg) {
  const toks = tokenizeSegment(seg);
  if (!toks.length) return null;
  if (toks[0] === 'git') {
    const sub = gitSubcommand(toks.slice(1));
    if (sub === 'push') return 'push';
    if (sub === 'commit') return 'commit';
  } else if (toks[0] === 'gh') {
    const { noun, verb } = ghSubcommand(toks.slice(1));
    if (noun === 'pr' && verb === 'create') return 'pr';
    if (noun === 'issue' && verb === 'create') return 'issue';
    if (noun === 'release' && verb === 'create') return 'tag';
  }
  return null;
}

// Return the "shipped" kind for a shell command, or null. Exported for tests.
// Splits on shell separators and only classifies a segment whose *actual*
// leading command is git/gh — so a quoted mention ("git push later" inside an
// echo or a commit message) no longer false-fires. Tolerates env prefixes,
// sudo/time, chained commands, and git global flags.
//
// Quoted spans are blanked BEFORE splitting: separators inside quotes
// (`echo "run git push && rejoice"`) used to create a fake segment whose
// leading command was git. The real command's own quoted args (`git commit
// -m "msg"`) classify the same with or without the message text, so blanking
// is lossless for detection. An unbalanced quote leaves the string untouched.
export function classifyShip(cmd) {
  const blanked = String(cmd || '')
    .replace(/'[^']*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
  const segments = blanked.split(/[;&|\n]+/);
  const found = new Set();
  for (const seg of segments) {
    const k = shipKindForSegment(seg);
    if (k) found.add(k);
  }
  for (const kind of SHIP_PRECEDENCE) if (found.has(kind)) return kind;
  return null;
}

const EVENTS_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function appendEvent(entry) {
  try {
    mkdirSync(dirname(EVENTS_LOG_PATH), { recursive: true });
    if (existsSync(EVENTS_LOG_PATH)) {
      const st = statSync(EVENTS_LOG_PATH);
      if (st.size > EVENTS_LOG_ROTATE_BYTES) {
        renameSync(EVENTS_LOG_PATH, EVENTS_LOG_PATH + '.1');
      }
    }
    appendFileSync(EVENTS_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* best-effort log: hooks must never fail because of an unwritable events.jsonl */ }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseInput() {
  const raw = readStdin();
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

// Handle a single hook event. Exported so the bundled exe can dispatch
// directly (avoids spawning a child process per hook).
export function processHookEvent(event, input = {}) {
  const now = Date.now();
  // Each session writes its OWN state file (state-<sessionId>.json) so concurrent
  // sessions stop clobbering one shared state.json — that thrash made the card
  // jump between projects, the timer reset, and counters over-count. Subagent
  // hooks carry the parent's session_id, so their activity rolls up correctly.
  // No id (legacy payload) → the global state.json, preserving old behavior.
  const sid = input.session_id || input.sessionId || null;
  const update = (fn) => updateState(fn, sid);
  const reset = (seed) => resetState(seed, sid);

  function setActivity(patch) {
    update((s) => {
      Object.assign(s, patch);
      s.lastActivity = now;
      // Any hook firing means Claude Code is alive — clear the closed flag
      // in case a prior SessionEnd from a sibling session set it.
      s.claudeClosed = false;
      if (!s.sessionStart) s.sessionStart = now;
      return s;
    });
  }

  switch (event) {
    case 'SessionStart': {
      reset({
        cwd: input.cwd || process.cwd(),
        model: input.model?.id || input.model || 'claude',
        status: 'idle',
      });
      // Self-heal the daemon. A reboot, crash, OS sleep, or closed terminal can
      // leave nothing running, so the card silently never appears — and on
      // macOS/Linux there's no login-autostart entry at all (only Windows wires
      // a Run key). Every Claude Code session begins with this hook, so make it
      // (best-effort) guarantee the daemon is up: presence is then assured
      // exactly when you're using Claude, on every platform. ensureDaemonRunning
      // is a no-op when a daemon is already alive and is cooldown-guarded against
      // spawn storms; the daemon's atomic claim reaps any duplicate. Opt out
      // with `autostart:false` in config.
      try {
        let autostart = true;
        try { autostart = loadConfig().autostart !== false; } catch { /* unreadable config — default on */ }
        ensureDaemonRunning({ autostart });
      } catch { /* presence is best-effort — never break the user's turn */ }
      break;
    }
    case 'UserPromptSubmit': {
      update((s) => {
        s.messages += 1;
        s.lastUserPrompt = now;
        s.lastActivity = now;
        s.status = 'thinking';
        s.claudeClosed = false;
        if (!s.sessionStart) s.sessionStart = now;
        if (input.cwd) s.cwd = input.cwd;
        return s;
      });
      break;
    }
    case 'PreToolUse': {
      const toolName = input.tool_name || input.toolName || 'tool';
      const toolInput = input.tool_input || input.toolInput || {};
      const file = toolInput.file_path || toolInput.path || toolInput.notebook_path || null;
      update((s) => {
        s.tools += 1;
        s.toolBreakdown[toolName] = (s.toolBreakdown[toolName] || 0) + 1;
        s.currentTool = toolName;
        s.currentFile = shortFile(file);
        s.toolStartedAt = now;
        s.status = 'working';
        s.lastActivity = now;
        s.claudeClosed = false;
        if (!s.sessionStart) s.sessionStart = now;
        // Remember the running Bash command so the daemon can match custom
        // triggers (config.triggers) against it for a brief overlay frame.
        if (toolName === 'Bash' && toolInput.command) {
          s.lastBashCommand = String(toolInput.command).slice(0, 500);
          s.lastBashAt = now;
        }
        if (file && (toolName === 'Read' || toolName === 'NotebookEdit')) {
          s.filesOpened = pushUnique(s.filesOpened, file);
          if (toolName === 'Read') s.filesRead = pushUnique(s.filesRead, file);
        }
        return s;
      });
      break;
    }
    case 'PostToolUse': {
      const toolName = input.tool_name || input.toolName || '';
      const toolInput = input.tool_input || input.toolInput || {};
      const file = toolInput.file_path || toolInput.path || null;
      // Just-shipped detection: any Bash command that contains `git push`
      // or `git commit`. Capture cwd + branch + last commit subject NOW
      // — by the time the daemon renders the next frame this info may be
      // gone (Claude often `cd`s after a commit).
      let shipKind = null;
      let shipSubject = null;
      let shipBranch = null;
      if (toolName === 'Bash') {
        shipKind = classifyShip(toolInput.command);
        if (shipKind) {
          const shipCwd = input.cwd || process.cwd();
          shipBranch = detectGitBranch(shipCwd) || null;
          // Only commit/push carry a meaningful "what shipped" subject; a PR
          // or issue creation doesn't map to a commit message.
          if (shipKind === 'commit' || shipKind === 'push') {
            shipSubject = detectLastCommitSubject(shipCwd) || null;
          }
        }
      }
      update((s) => {
        s.currentTool = null;
        s.toolStartedAt = null;
        s.lastActivity = now;
        s.claudeClosed = false;
        if (!s.sessionStart) s.sessionStart = now;
        if (file && (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit')) {
          s.filesEdited = pushUnique(s.filesEdited, file);
          s.filesOpened = pushUnique(s.filesOpened, file);
        }
        if (shipKind) {
          s.justShipped = now;
          s.justShippedKind = shipKind;
          s.justShippedSubject = shipSubject;
          s.justShippedBranch = shipBranch;
        }
        // NOTE: PostToolUse tool_response carries no model usage, so this
        // never fired (the daemon overrides state.tokens from the transcript —
        // the documented single source of truth). Removed to kill a latent
        // double-count if a future Claude Code version did attach usage here.
        return s;
      });
      break;
    }
    case 'Notification': {
      update((s) => {
        s.status = 'notification';
        s.lastNotification = now;
        s.lastActivity = now;
        s.claudeClosed = false;
        s.currentTool = null;
        s.currentFile = null;
        if (!s.sessionStart) s.sessionStart = now;
        return s;
      });
      appendEvent({ type: 'notification', ts: now, cwd: input.cwd || null });
      break;
    }
    case 'PreCompact': {
      // Compaction is mechanically distinct from "thinking" — the model is
      // rewriting earlier context, not advancing a turn. Surface it as its
      // own state so the card stops reading "Thinking…" for the 10-60s
      // compactions can take on big sessions.
      update((s) => {
        s.status = 'compacting';
        s.compactStartedAt = now;
        s.compactTrigger = input.trigger || input.matcher || null;
        s.currentTool = null;
        s.currentFile = null;
        s.lastActivity = now;
        s.claudeClosed = false;
        if (!s.sessionStart) s.sessionStart = now;
        return s;
      });
      appendEvent({ type: 'precompact', ts: now, trigger: input.trigger || input.matcher || null, cwd: input.cwd || null });
      break;
    }
    // No PostCompact case: Claude Code has no such event. Post-compaction
    // arrives as SessionStart (source:'compact'), whose resetState clears the
    // compacting marker — so the `compacting` state ends without a handler.
    case 'SessionEnd': {
      // Authoritative "Claude Code is gone" signal — don't wait on the
      // staleSessionMin timeout. applyIdle short-circuits to stale when it
      // sees claudeClosed=true. Any subsequent hook from another live
      // session will flip the flag back to false.
      update((s) => {
        s.status = 'stale';
        s.claudeClosed = true;
        s.currentTool = null;
        s.currentFile = null;
        s.lastActivity = now;
        return s;
      });
      break;
    }
    case 'Stop':
    case 'SubagentStop':
    default: {
      setActivity({ status: 'idle', currentTool: null, currentFile: null });
    }
  }
}

// Stdin-driven CLI form: read JSON event payload from stdin, dispatch, ack.
// The `{continue:true}` ack is a documented contract (SECURITY.md) — Claude
// Code reads it on every hook — so a state-write failure (full/unwritable
// tmpdir) must never stop us from emitting it. Dispatch is best-effort; the
// ack always goes out.
export function runHookCli(event) {
  try {
    processHookEvent(event, parseInput());
  } catch { /* presence is best-effort; never break the user's turn */ }
  finally {
    try { process.stdout.write(JSON.stringify({ continue: true })); } catch { /* stdout closed */ }
  }
}

// Run directly when invoked as `node src/hook.js <event>`. Detection is based
// on whether argv[1] ends in this filename — when imported (e.g. by cli.js),
// argv[1] won't match.
const argv1 = (process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
if (argv1.endsWith('/src/hook.js') || argv1.endsWith('/hook.js')) {
  runHookCli(process.argv[2] || 'unknown');
}
