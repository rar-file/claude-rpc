#!/usr/bin/env node
import { readFileSync, appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { updateState, resetState, pushUnique, shortFile } from './state.js';
import { EVENTS_LOG_PATH } from './paths.js';

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
        s.status = 'working';
        s.lastActivity = now;
        s.claudeClosed = false;
        if (!s.sessionStart) s.sessionStart = now;
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
      updateState((s) => {
        s.currentTool = null;
        s.lastActivity = now;
        s.claudeClosed = false;
        if (!s.sessionStart) s.sessionStart = now;
        if (file && (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit')) {
          s.filesEdited = pushUnique(s.filesEdited, file);
          s.filesOpened = pushUnique(s.filesOpened, file);
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
