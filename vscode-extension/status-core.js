// Pure view logic for the VS Code extension — no `vscode` import, so the
// root test suite can exercise it with plain node:test.
//
// This is a deliberately small mirror of the daemon's presentation layer
// (src/format.js). The two read the same state.json but serve different
// surfaces, and the extension must work standalone from a .vsix with zero
// dependencies — so the handful of formatters it needs are duplicated here
// rather than imported across package boundaries. The daemon remains the
// source of truth for Discord; divergence here only affects the status bar.
// Known simplification: no transcript-mtime liveness probe (findLiveSessions),
// so "is Claude still open?" leans on hook recency + the claudeClosed flag.
'use strict';

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
  resolveStatus,
  buildView,
  fmtNum,
  fmtDuration,
  fmtHours,
  humanModel,
  projectName,
  dayKey,
};
