// View logic for the VS Code extension — no `vscode` import, so the root test
// suite can exercise it with plain node:test.
//
// This is a deliberately small mirror of the daemon's state selection
// (src/state.js + src/presence.js) and presentation layer (src/format.js).
// The two read the same state files but serve different surfaces, and the
// extension must work standalone from a .vsix with zero dependencies — so the
// handful of helpers it needs are duplicated here rather than imported across
// package boundaries. The daemon remains the source of truth for Discord;
// divergence here only affects the status bar.
// Known simplification: no transcript-mtime liveness probe (findLiveSessions),
// so "is Claude still open?" leans on hook recency + the claudeClosed flag.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STALE_MIN_DEFAULT = 5;     // mirrors config.staleSessionMin
const IDLE_SEC_DEFAULT = 60;     // mirrors config.idleThresholdSec
const NOTIFICATION_SEC = 8;      // mirrors config.notificationWindowSec
const SHIPPED_SEC = 60;          // mirrors config.shippedFrameSec

function fmtNum(n) {
  if (!n) return '0';
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s % 60}s`;
}

function fmtHours(ms) {
  if (!ms || ms < 0) return '0h';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 10) return `${hours.toFixed(1)}h`;
  return `${Math.round(hours)}h`;
}

// claude-opus-4-7 → Opus 4.7 · claude-fable-5 → Fable 5 (same rules as
// src/format.js — version digits capped at two so date stamps don't read
// as a minor version).
function humanModel(id) {
  if (!id || typeof id !== 'string') return 'Claude';
  const m = id.match(/(opus|sonnet|haiku|fable)[^\d]*(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?/i);
  if (m) {
    const name = `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}`;
    return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
  }
  for (const tier of ['Fable', 'Opus', 'Sonnet', 'Haiku']) {
    if (new RegExp(tier, 'i').test(id)) return tier;
  }
  return 'Claude';
}

function projectName(cwd) {
  if (!cwd) return '';
  const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

// Local-time YYYY-MM-DD — must match the scanner's dayKey so today's bucket
// in aggregate.byDay resolves.
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Session state files ─────────────────────────────────────────────────
// Claude Code's hooks write one state-<sessionId>.json per session into the
// state dir (src/state.js statePathFor); the legacy global state.json is only
// written for hook payloads without a session id. Write-tmp
// (`*.json.<pid>.tmp`) and lock (`*.json.lock`) siblings don't end in `.json`.
const STATE_FILE_RE = /^state(-.+)?\.json$/;     // the whole family (watch filter)
const SESSION_FILE_RE = /^state-(.+)\.json$/;    // per-session files only

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Any state file at all? (setup detection: hooks have run on this machine)
function hasStateFiles(dir) {
  try { return fs.readdirSync(dir).some((n) => STATE_FILE_RE.test(n)); } catch { return false; }
}

// Mirror of src/state.js listSessionStates: every per-session state on disk,
// tagged with the sessionId recovered from its filename. Torn/unparseable
// files (mid-write) are skipped for this read.
function listSessionStates(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = SESSION_FILE_RE.exec(name);
    if (!m) continue;
    const parsed = readJson(path.join(dir, name));
    if (parsed && typeof parsed === 'object') out.push({ ...parsed, sessionId: m[1] });
  }
  return out;
}

// Mirror of src/presence.js pickActiveSession: stick to the displayed session
// while it's live (lastActivity within idleMs, not closed); otherwise the
// most-recently-active live session, then the most recent not-closed one,
// then the most recent overall. Returns { state, sessionId, liveCount }.
function pickActiveSession(states, displayedId, now, idleMs) {
  const list = (states || []).filter((s) => s && s.sessionId);
  if (!list.length) return { state: null, sessionId: null, liveCount: 0 };
  const isLive = (s) => !s.claudeClosed && now - (s.lastActivity || 0) <= idleMs;
  const liveCount = list.filter(isLive).length;
  const byRecent = [...list].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  const current = list.find((s) => s.sessionId === displayedId);
  if (current && isLive(current)) {
    return { state: current, sessionId: current.sessionId, liveCount };
  }
  const chosen = byRecent.find(isLive) || byRecent.find((s) => !s.claudeClosed) || byRecent[0];
  return { state: chosen, sessionId: chosen.sessionId, liveCount };
}

// The state to display, like src/state.js readActiveState — plus the
// daemon's stickiness when the caller passes the session it showed last, so
// the status bar follows the same session as the Discord card. Falls back to
// the legacy state.json when no per-session files exist.
// Returns { state, sessionId } (state null when nothing is on disk).
function readActiveState(dir, { displayedId = null, now = Date.now(), idleMs = IDLE_SEC_DEFAULT * 1000 } = {}) {
  const sessions = listSessionStates(dir);
  if (sessions.length) {
    const picked = pickActiveSession(sessions, displayedId, now, idleMs);
    if (picked.state) return { state: picked.state, sessionId: picked.sessionId };
  }
  return { state: readJson(path.join(dir, 'state.json')), sessionId: null };
}

// Light mirror of format.applyIdle + applyShipped: raw hook state → display
// status. Display-only — the daemon does the authoritative version for Discord.
function resolveStatus(state, { now = Date.now(), staleMin = STALE_MIN_DEFAULT, idleSec = IDLE_SEC_DEFAULT } = {}) {
  if (!state) return 'stale';
  if (state.claudeClosed) return 'stale';
  const age = now - (state.lastActivity || 0);
  if (age > staleMin * 60_000) return 'stale';
  let status = state.status || 'idle';
  if (status === 'notification' && now - (state.lastNotification || 0) > NOTIFICATION_SEC * 1000) {
    status = 'idle';
  }
  if (state.justShipped && now - state.justShipped <= SHIPPED_SEC * 1000) return 'shipped';
  if ((status === 'working' || status === 'thinking') && age > idleSec * 1000) return 'idle';
  return status;
}

const STATUS_ICON = {
  working: 'sync~spin',
  thinking: 'loading~spin',
  compacting: 'fold-down',
  shipped: 'rocket',
  notification: 'bell-dot',
  idle: 'check',
  stale: 'circle-outline',
  trigger: 'sync~spin',
};

const SHIP_VERB = {
  push: 'Pushed', commit: 'Committed', pr: 'PR opened', issue: 'Issue opened', tag: 'Tagged',
};

// Everything the status bar item needs: codicon, label, warning flag, and
// tooltip lines (markdown). `pausedUntil` (epoch ms, 0 = not paused) overlays
// everything — a paused card is the thing the user most wants to see at a glance.
function buildView(state, aggregate, pausedUntil, opts = {}) {
  const now = opts.now ?? Date.now();
  const showTokens = opts.showTokens !== false;

  // Marketplace installs without the CLI: no state files have ever existed
  // and `claude-rpc` isn't on PATH. Surface a setup prompt instead of a
  // dead "Away" item with actions that can't work.
  if (opts.setupNeeded) {
    return {
      status: 'setup',
      icon: 'rocket',
      label: 'Set up claude-rpc',
      warning: false,
      hidden: opts.hideWhenStale === true,
      tooltipLines: [
        '**Claude RPC** — companion CLI not detected',
        'This extension reads state files written by the `claude-rpc` CLI (the npm package that wires Claude Code\'s hooks and drives the Discord card).',
        '',
        'Click for one-command setup: `npx claude-rpc@latest setup`',
      ],
    };
  }

  const status = resolveStatus(state, { now, ...opts });
  const proj = projectName(state?.cwd);
  const tokens = state?.tokens
    ? (state.tokens.input || 0) + (state.tokens.output || 0) + (state.tokens.cacheRead || 0) + (state.tokens.cacheWrite || 0)
    : 0;

  let icon = STATUS_ICON[status] || 'check';
  let label;
  switch (status) {
    case 'working':      label = proj ? `Working · ${proj}` : 'Working'; break;
    case 'thinking':     label = proj ? `Thinking · ${proj}` : 'Thinking'; break;
    case 'compacting':   label = 'Compacting context'; break;
    case 'shipped':      label = SHIP_VERB[state?.justShippedKind] || 'Shipped'; break;
    case 'notification': label = proj ? `Needs you · ${proj}` : 'Claude needs you'; break;
    case 'idle':         label = proj ? `Idle · ${proj}` : 'Idle'; break;
    default:             label = 'Away';
  }
  if (showTokens && tokens > 0 && status !== 'stale') label += ` · ${fmtNum(tokens)} tok`;
  if (pausedUntil) {
    icon = 'debug-pause';
    label = `Paused (Discord) · ${label}`;
  }

  // ── Tooltip ────────────────────────────────────────────────────────────
  const lines = [];
  const model = humanModel(state?.model);
  if (status === 'stale') {
    lines.push('**Claude Code** — not running');
  } else {
    lines.push(`**Claude Code** — ${label.replace(/^Paused \(Discord\) · /, '')}`);
    const session = [];
    session.push(model);
    if (state?.sessionStart) session.push(`session ${fmtDuration(now - state.sessionStart)}`);
    if (state?.messages) session.push(`${state.messages} prompt${state.messages === 1 ? '' : 's'}`);
    if (state?.tools) session.push(`${state.tools} tool call${state.tools === 1 ? '' : 's'}`);
    lines.push(session.join(' · '));
    if (tokens > 0) {
      lines.push(`Tokens: ${fmtNum(tokens)} (in ${fmtNum(state.tokens.input)} · out ${fmtNum(state.tokens.output)} · cache ${fmtNum((state.tokens.cacheRead || 0) + (state.tokens.cacheWrite || 0))})`);
    }
    if (state?.currentFile) lines.push(`File: \`${state.currentFile}\``);
  }

  const today = aggregate?.byDay?.[dayKey(now)];
  if (today) {
    lines.push('');
    lines.push(`**Today**: ${fmtHours(today.activeMs)} · ${today.userMessages || 0} prompts · ${fmtNum((today.inputTokens || 0) + (today.outputTokens || 0) + (today.cacheReadTokens || 0) + (today.cacheWriteTokens || 0))} tokens`);
  }
  if (aggregate) {
    lines.push(`**All-time**: ${fmtHours(aggregate.activeMs)} · ${aggregate.sessions || 0} sessions · ${(aggregate.streak || 0)}-day streak`);
  }
  if (pausedUntil) {
    lines.push('');
    const d = new Date(pausedUntil);
    lines.push(`Discord card paused until ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
  }

  return {
    status,
    icon,
    label,
    warning: status === 'notification' && !pausedUntil,
    hidden: status === 'stale' && opts.hideWhenStale === true,
    tooltipLines: lines,
  };
}

module.exports = {
  STATE_FILE_RE,
  hasStateFiles,
  listSessionStates,
  pickActiveSession,
  readActiveState,
  resolveStatus,
  buildView,
  humanModel,
  projectName,
};
