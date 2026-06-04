#!/usr/bin/env node
import { readFileSync, appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { updateState, resetState, pushUnique, shortFile } from './state.js';
import { detectLastCommitSubject, detectGitBranch } from './git.js';
import { EVENTS_LOG_PATH } from './paths.js';

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

function shipKindForSegment(seg) {
  const toks = tokenizeSegment(seg);
  if (!toks.length) return null;
  if (toks[0] === 'git') {
    const sub = gitSubcommand(toks.slice(1));
    if (sub === 'push') return 'push';
    if (sub === 'commit') return 'commit';
  } else if (toks[0] === 'gh') {
    if (toks[1] === 'pr' && toks[2] === 'create') return 'pr';
    if (toks[1] === 'issue' && toks[2] === 'create') return 'issue';
    if (toks[1] === 'release' && toks[2] === 'create') return 'tag';
  }
  return null;
}

// Return the "shipped" kind for a shell command, or null. Exported for tests.
// Splits on shell separators and only classifies a segment whose *actual*
// leading command is git/gh — so a quoted mention ("git push later" inside an
// echo or a commit message) no longer false-fires. Tolerates env prefixes,
// sudo/time, chained commands, and git global flags.
export function classifyShip(cmd) {
  const segments = String(cmd || '').split(/[;&|\n]+/);
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

  function setActivity(patch) {
    updateState((s) => {
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
      resetState({
        cwd: input.cwd || process.cwd(),
        model: input.model?.id || input.model || 'claude',
        status: 'idle',
      });
      break;
    }
    case 'UserPromptSubmit': {
      updateState((s) => {
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
      updateState((s) => {
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
      updateState((s) => {
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
        const usage = input.tool_response?.usage || input.usage;
        if (usage) {
          s.tokens.input += usage.input_tokens || 0;
          s.tokens.output += usage.output_tokens || 0;
          s.tokens.cacheRead += usage.cache_read_input_tokens || 0;
          s.tokens.cacheWrite += usage.cache_creation_input_tokens || 0;
        }
        return s;
      });
      break;
    }
    case 'Notification': {
      updateState((s) => {
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
      updateState((s) => {
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
    case 'PostCompact': {
      // Compaction finished — clear the marker and drop to idle. The next
      // hook (UserPromptSubmit / PreToolUse) will set the real next state.
      updateState((s) => {
        s.status = 'idle';
        s.compactStartedAt = null;
        s.compactTrigger = null;
        s.lastActivity = now;
        s.claudeClosed = false;
        return s;
      });
      appendEvent({ type: 'postcompact', ts: now, cwd: input.cwd || null });
      break;
    }
    case 'SessionEnd': {
      // Authoritative "Claude Code is gone" signal — don't wait on the
      // staleSessionMin timeout. applyIdle short-circuits to stale when it
      // sees claudeClosed=true. Any subsequent hook from another live
      // session will flip the flag back to false.
      updateState((s) => {
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
export function runHookCli(event) {
  processHookEvent(event, parseInput());
  process.stdout.write(JSON.stringify({ continue: true }));
}

// Run directly when invoked as `node src/hook.js <event>`. Detection is based
// on whether argv[1] ends in this filename — when imported (e.g. by cli.js),
// argv[1] won't match.
const argv1 = (process.argv[1] || '').replace(/\\/g, '/').toLowerCase();
if (argv1.endsWith('/src/hook.js') || argv1.endsWith('/hook.js')) {
  runHookCli(process.argv[2] || 'unknown');
}
