#!/usr/bin/env node
import './safe-stdio.js';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { updateState, resetState, pushUnique, shortFile } from './state.js';
import { detectLastCommitSubject, detectGitBranch } from './git.js';
import { EVENTS_LOG_PATH } from './paths.js';
import { loadConfig } from './config.js';
import { ensureDaemonRunning } from './ensure-daemon.js';
// Ship classification lives in ships.js (shared with the scanner).
import { classifyShip } from './ships.js';

// require()d, not imported: a builtin's ESM facade reads every export, and
// fs's lazy getters then load fs/promises and the fs streams on every hook
// event. The same goes for the rest of the hook's module graph.
const fs = createRequire(import.meta.url)('node:fs');
const { readFileSync, appendFileSync, existsSync, mkdirSync, statSync, renameSync } = fs;

const EVENTS_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function appendEvent(entry) {
  try {
    mkdirSync(dirname(EVENTS_LOG_PATH), { recursive: true });
    if (existsSync(EVENTS_LOG_PATH) && statSync(EVENTS_LOG_PATH).size > EVENTS_LOG_ROTATE_BYTES) {
      renameSync(EVENTS_LOG_PATH, EVENTS_LOG_PATH + '.1');
    }
    appendFileSync(EVENTS_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* best-effort log: hooks must never fail because of an unwritable events.jsonl */ }
}

// The JSON event payload on stdin. Unreadable, empty, or malformed → {}.
function parseInput() {
  try { return JSON.parse(readFileSync(0, 'utf8')); } catch { return {}; }
}

// Handle a single hook event. Exported so the bundled exe can dispatch
// directly (avoids spawning a child process per hook).
export function processHookEvent(event, input = {}, now = Date.now()) {
  // Each session writes its OWN state file (state-<sessionId>.json) so concurrent
  // sessions stop clobbering one shared state.json — that thrash made the card
  // jump between projects, the timer reset, and counters over-count. Subagent
  // hooks carry the parent's session_id, so their activity rolls up correctly.
  // No id (legacy payload) → the global state.json, preserving old behavior.
  const sid = input.session_id || input.sessionId || null;
  // PreToolUse/PostToolUse are wired `async` (ASYNC_EVENTS in install.js) so
  // they never hold up a tool call — which means they can land out of order:
  // a slow PreToolUse after its own PostToolUse, or a PostToolUse after the
  // turn's (synchronous) Stop. `now` is the hook process's START time, i.e.
  // Claude Code's dispatch order, so an event older than the last one applied
  // is `stale`: it may still add to counters but must not overwrite status.
  const update = (fn) => updateState((s) => {
    const stale = now < (s.lastEventAt || 0);
    if (!stale) s.lastEventAt = now;
    return fn(s, stale);
  }, sid);
  const reset = (seed) => resetState({ lastEventAt: now, ...seed }, sid);

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
      // Post-compaction continuation, NOT a new session: Claude Code re-fires
      // SessionStart with source:'compact' after every compaction. Resetting
      // here wiped the elapsed timer and message/tool/file counters mid-turn.
      // Just clear the compacting marker and carry on; the turn that triggered
      // the compaction resumes immediately, hence 'working'.
      if (input.source === 'compact') {
        update((s) => {
          delete s.compactStartedAt;
          delete s.compactTrigger;
          s.status = 'working';
          s.lastActivity = now;
          s.claudeClosed = false;
          if (!s.sessionStart) s.sessionStart = now;
          return s;
        });
        break;
      }
      reset({
        cwd: input.cwd || process.cwd(),
        model: input.model?.id || input.model || 'claude',
        status: 'idle',
      });
      // Self-heal the daemon. A reboot, crash, OS sleep, or closed terminal can
      // leave nothing running, so the card silently never appears — and the
      // login-autostart entry (Run key / LaunchAgent / systemd --user) can be
      // missing, unloaded or unsupported (no systemd --user session, other
      // platforms). Every Claude Code session begins with this hook, so make it
      // (best-effort) guarantee the daemon is up: presence is then assured
      // exactly when you're using Claude, on every platform. ensureDaemonRunning
      // is a no-op when a daemon is already alive and is cooldown-guarded against
      // spawn storms; the daemon's atomic claim reaps any duplicate. Opt out
      // with `autostart:false` in config.
      try {
        // CLAUDE_RPC_NO_AUTOSTART=1 is the per-environment opt-out (CI, containers,
        // the test suite) for when editing config.json isn't practical.
        let autostart = process.env.CLAUDE_RPC_NO_AUTOSTART !== '1';
        try { if (autostart) autostart = loadConfig().autostart !== false; } catch { /* unreadable config — default on */ }
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
      update((s, stale) => {
        s.tools += 1;
        s.toolBreakdown[toolName] = (s.toolBreakdown[toolName] || 0) + 1;
        if (!s.sessionStart) s.sessionStart = now;
        if (!stale) {
          s.currentTool = toolName;
          s.currentFile = shortFile(file);
          s.toolStartedAt = now;
          s.status = 'working';
          s.lastActivity = now;
          s.claudeClosed = false;
          // Remember the running Bash command so the daemon can match custom
          // triggers (config.triggers) against it for a brief overlay frame.
          if (toolName === 'Bash' && toolInput.command) {
            s.lastBashCommand = String(toolInput.command).slice(0, 500);
            s.lastBashAt = now;
          }
        }
        if (file && (toolName === 'Read' || toolName === 'NotebookEdit')) {
          s.filesOpened = pushUnique(s.filesOpened, file);
          if (toolName === 'Read') s.filesRead = pushUnique(s.filesRead, file);
        }
        return s;
      });
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': { // a failed call fires only the latter
      const failed = event === 'PostToolUseFailure';
      const toolName = input.tool_name || input.toolName || '';
      const toolInput = input.tool_input || input.toolInput || {};
      const file = toolInput.file_path || toolInput.path || toolInput.notebook_path || null;
      // Just-shipped detection: a Bash command that pushes, commits, or opens
      // a PR / issue / release (ships.classifyShip: push|commit|pr|issue|tag).
      // Capture cwd + branch + last commit subject NOW — by the time the
      // daemon renders the next frame this info may be gone (Claude often
      // `cd`s after a commit).
      let shipKind = null;
      let shipSubject = null;
      let shipBranch = null;
      if (toolName === 'Bash' && !failed) { // a failed `git commit` shipped nothing
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
      update((s, stale) => {
        if (!stale) {
          s.currentTool = null;
          s.toolStartedAt = null;
          s.lastActivity = now;
          s.claudeClosed = false;
        }
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
    case 'PostCompact': {
      // Claude Code 2.1.76+. Older versions only re-fire SessionStart
      // (source:'compact'), handled above. An auto-compaction resumes the turn
      // that triggered it; a manual /compact leaves the session waiting on you.
      update((s) => {
        const manual = (input.trigger || s.compactTrigger) === 'manual';
        delete s.compactStartedAt;
        delete s.compactTrigger;
        s.status = manual ? 'idle' : 'working';
        s.lastActivity = now;
        s.claudeClosed = false;
        if (!s.sessionStart) s.sessionStart = now;
        return s;
      });
      break;
    }
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
    case 'SubagentStop': {
      // A subagent finishing is not the SESSION going idle — the parent turn
      // is still running (often with sibling subagents in flight). Flipping to
      // idle here showed "Standing by" mid-generation. Just record liveness;
      // the parent's own Stop/PreToolUse hooks drive status.
      setActivity({});
      break;
    }
    case 'StopFailure': // the turn ended on an API error — Stop never fires
    case 'Stop':
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
    // now − uptime = when this process was spawned, so dispatch order
    // survives node's (variable) startup time — see `stale` above. (The same
    // instant as performance.timeOrigin, to Date.now()'s 1ms resolution,
    // without loading perf_hooks.)
    processHookEvent(event, parseInput(), Math.round(Date.now() - process.uptime() * 1000));
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
