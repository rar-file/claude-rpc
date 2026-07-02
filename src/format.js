import { basename, dirname, extname } from 'node:path';
import { dayKey, weekKey, DATE_SUFFIX_RE, cleanProjectName } from './scanner.js';
import { fmtCost } from './pricing.js';
import { languageOf } from './languages.js';
import { detectGitBranch, detectGitRepo } from './git.js';
import { fmtResetTime, fmtResetDay } from './usage.js';
import { fmtNum, fmtHours } from './fmt.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function fmtLinesNet(n) {
  if (!n) return '0';
  const sign = n > 0 ? '+' : '−';
  return `${sign}${fmtNum(Math.abs(n))}`;
}

function topEntry(map) {
  if (!map) return null;
  let best = null;
  for (const [k, v] of Object.entries(map)) {
    if (!best || v > best.v) best = { k, v };
  }
  return best;
}

function topN(map, n = 3) {
  if (!map) return [];
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function fmtHourLocal(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Tighter formatter for the working-frame "tool has been running for X" var.
// Sub-minute: bare seconds. Sub-hour: decimal minutes (1.5min) up to 10,
// integer minutes thereafter. Hour+: "1h 5m" to match fmtDuration. The
// short forms keep the working frame readable on Discord's narrow rows
// — fmtDuration's "120m 0s" wraps awkwardly there.
function fmtToolElapsed(ms) {
  if (!ms || ms < 0) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = sec / 60;
  if (min < 10) return `${min.toFixed(1)}min`;
  if (sec < 3600) return `${Math.round(min)}min`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${m}m`;
}

function plural(n, sing, plur) {
  const word = n === 1 ? sing : (plur || `${sing}s`);
  return `${fmtNum(n)} ${word}`;
}

// claude-opus-4-7 → Opus 4.7 · claude-sonnet-4-6-20250514 → Sonnet 4.6 ·
// claude-fable-5 → Fable 5 (no minor version). Version digits are capped at
// two so a trailing date stamp ("…-5-20260301") can't be read as a minor.
function humanModel(id) {
  if (!id || typeof id !== 'string') return 'Claude';
  const m = id.match(/(opus|sonnet|haiku|fable)[^\d]*(\d{1,2})(?!\d)(?:[-.](\d{1,2})(?!\d))?/i);
  if (m) {
    const name = `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}`;
    return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`;
  }
  if (/fable/i.test(id)) return 'Fable';
  if (/opus/i.test(id)) return 'Opus';
  if (/sonnet/i.test(id)) return 'Sonnet';
  if (/haiku/i.test(id)) return 'Haiku';
  return 'Claude';
}

// mcp__claude_ai_Vercel__deploy_to_vercel → Vercel:deploy · mcp__github__list → github:list
function humanTool(name) {
  if (!name) return '';
  if (name.startsWith('mcp__')) {
    const parts = name.split('__').filter(Boolean);
    if (parts.length >= 3) {
      const server = parts[parts.length - 2].replace(/^claude[_ ]?ai[_ ]?/i, '');
      const action = parts[parts.length - 1];
      return `${server}:${action}`;
    }
    return parts.slice(1).join(':');
  }
  return name;
}

// Given a real path, the basename is exact: "/home/alice/my-app" → "my-app".
// Given a Claude Code project *slug* (path with separators replaced by '-')
// we can only best-effort the last segment: "C--Users-simmo-Downloads-CLAUDE"
// → "CLAUDE". A hyphenated name ("my-app") can't be recovered from a bare slug
// because '-' also encodes the separators — but callers pass the real cwd
// wherever they have it (live sessions, aggregate keys), so the slug branch is
// a rare fallback for transcripts whose cwd we never saw.
function humanProject(slugOrPath) {
  if (!slugOrPath) return '';
  const raw = String(slugOrPath);
  let name;
  if (raw.includes('/') || raw.includes('\\')) {
    name = basename(raw);
  } else if (/^[A-Za-z]--/.test(raw)
        || raw.startsWith('-home-')
        || raw.startsWith('-Users-')
        || raw.startsWith('-tmp-')
        || raw.startsWith('-var-')
        || raw.startsWith('-opt-')) {
    // Path-style slug — strip a leading Windows drive letter ("C--") and take
    // the last segment. (The old code filtered out every segment equal to 'C',
    // which wrongly dropped a real path/project segment literally named "C".)
    const parts = raw.replace(/^[A-Za-z]--/, '').split('-').filter(Boolean);
    name = parts[parts.length - 1] || raw;
  } else {
    name = raw;
  }
  return cleanProjectName(name);
}

function statusVerbose(status, currentToolPretty, idleMs) {
  switch (status) {
    case 'working': return currentToolPretty ? `Using ${currentToolPretty}` : 'Working';
    case 'thinking': return 'Thinking';
    case 'compacting': return 'Compacting context';
    case 'notification': return 'Waiting on you';
    case 'idle': {
      if (idleMs && idleMs > 60_000) {
        const mins = Math.floor(idleMs / 60_000);
        if (mins < 60) return `Idle · ${mins}m`;
        const hours = Math.floor(mins / 60);
        return `Idle · ${hours}h`;
      }
      return 'Standing by';
    }
    case 'stale': return 'Away';
    default: return status || 'Active';
  }
}

function fmtHour(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return '';
  const hh = String(n).padStart(2, '0');
  return `${hh}:00`;
}

// Detect a cwd that would leak the user's OS username if rendered on
// Discord. Examples:
//   /home/lucas              → basename matches $USER → leak
//   C:\Users\lucas           → equals $USERPROFILE → leak
//   /Users/lucas/projects/x  → basename "x" ≠ user → fine
// On a real privacy-sensitive cwd (the home dir itself, with no project
// scoping), buildVars falls back to `appName` so the card reads
// "Idle in Claude Code" instead of "Idle in lucas".
function looksLikeUsernameLeak(cwd) {
  if (!cwd) return false;
  // Check both POSIX and Windows env vars unconditionally — a test or
  // edge case might have one without the other, and over-suppressing
  // the leak side is the safe direction.
  const homes = [process.env.HOME, process.env.USERPROFILE].filter(Boolean);
  const users = [process.env.USER, process.env.USERNAME].filter(Boolean);
  // Normalize path separators so Windows-style cwds work on POSIX
  // basename (which doesn't split on '\').
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const cwdN = norm(cwd);
  for (const home of homes) {
    if (cwdN === norm(home)) return true;
  }
  if (users.length) {
    const base = cwdN.split('/').pop() || '';
    for (const u of users) {
      if (base === u.toLowerCase()) return true;
    }
  }
  return false;
}

// Trim "C:\repo\src\app\page.tsx" → "src/app/page.tsx" (3 trailing segments).
function prettyFilePath(p) {
  if (!p) return '';
  const norm = String(p).replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 3) return parts.join('/');
  return parts.slice(-3).join('/');
}

export function buildVars(state, config, aggregate) {
  const sessionReal = (state.tokens?.input || 0) + (state.tokens?.output || 0);
  const sessionCacheRead = state.tokens?.cacheRead || 0;
  const sessionCacheWrite = state.tokens?.cacheWrite || 0;
  // {tokens} / {tokensFmt} now means the grand total (in + out + cache).
  const sessionTokens = sessionReal + sessionCacheRead + sessionCacheWrite;
  const duration = state.sessionStart ? Date.now() - state.sessionStart : 0;
  // Privacy: when cwd is the user's home dir (or its basename matches the
  // OS username), don't render it. "Idle in lucas" on Discord is a username
  // leak to anyone viewing the card. Fall back to the configured app name.
  const cwdIsLeaky = looksLikeUsernameLeak(state.cwd);
  const safeCwd = cwdIsLeaky ? '' : (state.cwd || '');
  const appName = config?.appName || 'Claude Code';
  // Project label with the home-dir/username-leak guard applied — shared by the
  // single-session label and the concurrent list so neither renders "lucas".
  const safeProject = (cwd) => looksLikeUsernameLeak(cwd) ? appName : (humanProject(cwd) || appName);
  const projectPretty = safeProject(state.cwd);
  const currentToolPretty = humanTool(state.currentTool);
  const modelPretty = humanModel(state.model);

  const agg = aggregate || {};
  const allReal = (agg.inputTokens || 0) + (agg.outputTokens || 0);
  const allCacheRead = agg.cacheReadTokens || 0;
  const allCacheWrite = agg.cacheWriteTokens || 0;
  const allCache = allCacheRead + allCacheWrite;
  const allBillable = allReal + allCacheWrite;
  // {allTokens} / {allTokensFmt} now means the grand total across history.
  const allTotal = allReal + allCache;
  const liveSessions = state.liveSessions || [];
  const concurrent = liveSessions.length;
  // "Other" sessions beyond this one — what you actually want to gate the
  // concurrent frame on (== 1 just means "you", == 2+ is interesting).
  const concurrentOther = Math.max(0, concurrent - 1);
  const concurrentListPretty = liveSessions
    .slice(0, 3)
    .map((s) => safeProject(typeof s === 'string' ? s : (s.cwd || s.project || '')))
    .filter(Boolean)
    .join(', ') || '—';

  const sessionActive = state.sessionStart && state.status !== 'stale' ? 1 : 0;

  // Today's per-day bucket (from aggregate.byDay) — falls back to zeros.
  const today = agg.byDay?.[dayKey(Date.now())] || {
    activeMs: 0, userMessages: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sessions: 0,
  };
  const todayReal = (today.inputTokens || 0) + (today.outputTokens || 0);
  const todayCache = (today.cacheReadTokens || 0) + (today.cacheWriteTokens || 0);
  // {todayTokens} / {todayTokensFmt} = grand total today (in + out + cache).
  const todayTokensSum = todayReal + todayCache;

  const bestDay = agg.bestDay || null;

  // This week's bucket.
  const thisWeek = agg.byWeek?.[weekKey(Date.now())] || {
    activeMs: 0, userMessages: 0, toolCalls: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sessions: 0,
  };
  const weekTokensSum = (thisWeek.inputTokens || 0) + (thisWeek.outputTokens || 0)
    + (thisWeek.cacheReadTokens || 0) + (thisWeek.cacheWriteTokens || 0);

  // Peak hour-of-day.
  const peak = agg.peakHour || null;

  // Top-edited file.
  const hotspot = agg.topEditedFiles?.[0] || null;

  // Per-project stats for the current cwd, keyed by the cleaned basename so
  // it lines up with how scanner.aggregateFrom stores them.
  const cwdLeaf = state.cwd ? state.cwd.split(/[\\/]/).filter(Boolean).pop() || '' : '';
  const projectKey = cleanProjectName(cwdLeaf);
  const projectStats = projectKey ? (agg.projects?.[projectKey] || null) : null;

  // Phase 1 enrichments — code churn, languages, bash, web, subagents, cost.
  const todayLinesAdded = today.linesAdded || 0;
  const todayLinesRemoved = today.linesRemoved || 0;
  const todayLinesNet = todayLinesAdded - todayLinesRemoved;
  const weekLinesAdded = thisWeek.linesAdded || 0;
  const weekLinesRemoved = thisWeek.linesRemoved || 0;
  const weekLinesNet = weekLinesAdded - weekLinesRemoved;
  const allLinesAdded = agg.linesAdded || 0;
  const allLinesRemoved = agg.linesRemoved || 0;
  const allLinesNet = (agg.linesNet ?? (allLinesAdded - allLinesRemoved));

  // Top language overall (by edits).
  const langSorted = Object.entries(agg.languages || {})
    .sort((x, y) => (y[1].edits || 0) - (x[1].edits || 0));
  const topLang = langSorted[0] || null;
  const languagesLabel = langSorted.slice(0, 3).map(([n]) => n).join(' · ');

  const topBash = topEntry(agg.bashCommands);
  const topDomain = topEntry(agg.webDomains);
  const topSubagent = topEntry(agg.subagents);

  // MCP vs built-in.
  const mcpCalls = agg.mcpToolCalls || 0;
  const builtinCalls = agg.builtinToolCalls || 0;
  const totalToolCalls = mcpCalls + builtinCalls;
  const mcpPct = totalToolCalls > 0 ? Math.round((mcpCalls / totalToolCalls) * 100) : 0;

  // Cost.
  const todayCost = today.cost || 0;
  const weekCost = thisWeek.cost || 0;
  const allCost = agg.estimatedCost || 0;
  // Per-project cost for the current cwd's project.
  const projectCost = projectStats?.cost || 0;

  // Goals (v0.10) — daily/weekly targets → progress label + hit flag.
  const goalsCfg = config?.goals || {};
  const todayHoursNum = (today.activeMs || 0) / 3_600_000;
  const weekHoursNum = (thisWeek.activeMs || 0) / 3_600_000;
  const pctOf = (cur, target) => (target > 0 ? Math.min(999, Math.round((cur / target) * 100)) : 0);
  const goalDailyHoursPct = pctOf(todayHoursNum, goalsCfg.dailyHours || 0);
  const goalDailyPromptsPct = pctOf(today.userMessages || 0, goalsCfg.dailyPrompts || 0);
  const goalWeeklyHoursPct = pctOf(weekHoursNum, goalsCfg.weeklyHours || 0);
  let goalLabel = '', goalHit = 0;
  if ((goalsCfg.dailyHours || 0) > 0) {
    goalLabel = `${fmtHours(today.activeMs || 0)} / ${goalsCfg.dailyHours}h · ${goalDailyHoursPct}%`;
    goalHit = goalDailyHoursPct >= 100 ? 1 : 0;
  } else if ((goalsCfg.dailyPrompts || 0) > 0) {
    goalLabel = `${today.userMessages || 0} / ${goalsCfg.dailyPrompts} prompts · ${goalDailyPromptsPct}%`;
    goalHit = goalDailyPromptsPct >= 100 ? 1 : 0;
  } else if ((goalsCfg.weeklyHours || 0) > 0) {
    goalLabel = `${fmtHours(thisWeek.activeMs || 0)} / ${goalsCfg.weeklyHours}h this week · ${goalWeeklyHoursPct}%`;
    goalHit = goalWeeklyHoursPct >= 100 ? 1 : 0;
  }

  // Monthly cost budget (v0.10) — month-to-date spend vs budget.
  const budgetCfg = config?.budget || {};
  const monthlyBudget = budgetCfg.monthly || 0;
  const monthPrefix = dayKey(Date.now()).slice(0, 7); // YYYY-MM
  let mtdCost = 0;
  for (const [k, d] of Object.entries(agg.byDay || {})) {
    if (k.startsWith(monthPrefix)) mtdCost += d.cost || 0;
  }
  const budgetPct = monthlyBudget > 0 ? Math.round((mtdCost / monthlyBudget) * 100) : 0;
  const budgetWarn = monthlyBudget > 0 && budgetPct >= (budgetCfg.warnAtPct || 80) ? 1 : 0;
  const budgetLabel = monthlyBudget > 0 ? `${fmtCost(mtdCost)} / ${fmtCost(monthlyBudget)} · ${budgetPct}%` : '';

  // Weekday name from today's date.
  const weekdayLabel = WEEKDAY_NAMES[new Date().getDay()];

  // Earliest activity timestamp today → "started 09:14".
  const todayStartLabel = today.firstTs ? `started ${fmtHourLocal(today.firstTs)}` : '';

  const notificationCount = agg.notifications || 0;

  // Streak milestones: every multiple of 7, plus 30/60/100/365.
  const streak = agg.streak || 0;
  const streakIsMilestone = streak > 0
    && (streak % 7 === 0 || streak === 30 || streak === 60 || streak === 100 || streak === 365)
    ? 1 : 0;

  // Session-duration milestones — surface a celebratory frame for a few
  // minutes after the live session crosses 1h/2h/3h/5h/8h/12h. Stateless:
  // derived from elapsed duration, so no per-session bookkeeping is needed.
  const SESSION_MILESTONES_H = [1, 2, 3, 5, 8, 12];
  let sessionMilestoneHit = 0;
  let sessionMilestoneLabel = '';
  if (sessionActive && duration > 0) {
    for (const h of SESSION_MILESTONES_H) {
      const t = h * 3_600_000;
      if (duration >= t && duration - t < 5 * 60_000) {
        sessionMilestoneHit = 1;
        sessionMilestoneLabel = `${h}-hour session`;
      }
    }
  }

  // Model split — per-model share of all-time spend, biggest first.
  const modelSplit = Array.isArray(agg.modelSplit) ? agg.modelSplit : [];
  const topModelEntry = modelSplit[0] || null;
  const modelSplitLabel = modelSplit
    .slice(0, 3)
    .filter((m) => (m.costPct || 0) > 0)
    .map((m) => `${humanModel(m.model)} ${Math.round(m.costPct * 100)}%`)
    .join(' · ');

  // Idle duration for sleeker idle copy.
  const idleMs = state.status === 'idle' && state.lastActivity
    ? Math.max(0, Date.now() - state.lastActivity)
    : 0;

  // Tool-duration spotlight. Empty until the running tool has burned past
  // a short threshold — quick Reads/Edits don't need a timer on the card,
  // and showing it flickers as fast tools complete. Once it does exceed
  // the threshold, "Bash · running tests · 2.5min" reads naturally.
  const toolMs = (state.status === 'working' && state.toolStartedAt)
    ? Math.max(0, Date.now() - state.toolStartedAt)
    : 0;
  const TOOL_ELAPSED_THRESHOLD_MS = 5_000;
  const toolElapsed = toolMs >= TOOL_ELAPSED_THRESHOLD_MS ? fmtToolElapsed(toolMs) : '';

  // Compaction vars — populated only while a compaction is in flight so
  // the {compactDuration} suffix in the compacting template collapses
  // away naturally otherwise (via fillTemplate's `·` collapse).
  const compactMs = state.compactStartedAt
    ? Math.max(0, Date.now() - state.compactStartedAt)
    : 0;
  const compactTrigger = state.compactTrigger || '';
  const compactTriggerLabel = compactTrigger === 'manual'
    ? 'manual compaction'
    : compactTrigger === 'auto'
      ? 'auto-compaction'
      : 'context squeeze';

  const currentFilePretty = prettyFilePath(state.currentFile);

  // ── File / directory / language vars ──────────────────────────────────────
  // Derived from state.currentFile. All empty-string when no file is active,
  // which keeps `requires`-based frame gating working unchanged.
  const currentFileNorm = state.currentFile ? String(state.currentFile).replace(/\\/g, '/') : '';
  const fileName = currentFileNorm ? basename(currentFileNorm) : '';
  const fileExt = currentFileNorm ? (extname(currentFileNorm).toLowerCase() || '') : '';
  const fileLang = currentFileNorm ? (languageOf(currentFileNorm) || '') : '';
  const fileLangUpper = fileLang ? fileLang.toUpperCase() : '';
  const fullDirName = currentFileNorm ? dirname(currentFileNorm) : '';
  const dirNameOnly = fullDirName ? basename(fullDirName) : '';

  // ── Git vars ──────────────────────────────────────────────────────────────
  // Cached per-cwd in src/git.js. Empty strings when not in a repo.
  const gitBranch = detectGitBranch(state.cwd) || '';
  const gitRepo = detectGitRepo(state.cwd) || '';

  const messages = state.messages || 0;
  const tools = state.tools || 0;
  const filesEdited = (state.filesEdited || []).length;
  const filesRead = (state.filesRead || []).length;
  const filesOpened = (state.filesOpened || []).length;

  // ── Subscription usage (state.usage, injected by the caller from
  // readUsageCache like liveSessions is). All-empty when the daemon hasn't
  // polled / polling is disabled / the cache went stale, so `requires`-gated
  // usage frames simply vanish rather than rendering blanks.
  const usage = state.usage || null;
  const usageSessionPct = usage?.sessionPct ?? '';
  const usageWeeklyPct = usage?.weeklyPct ?? '';
  let usageStateLabel = '';
  if (usage) {
    // The usage rotation frame's DETAILS line already shows "{usageWeeklyPct}%
    // weekly", so this state line must NOT repeat weekly% — it complements with
    // session% + reset day. (A weekly-only fallback lives below so the line
    // isn't empty when session% is absent and we'd otherwise show nothing.)
    const bits = [];
    if (usage.sessionPct != null) bits.push(`session ${usage.sessionPct}%`);
    const day = fmtResetDay(usage.weeklyResetsAt);
    if (day) bits.push(`resets ${day}`);
    // Only fall back to weekly% when the line would otherwise be empty.
    if (!bits.length && usage.weeklyPct != null) bits.push(`weekly ${usage.weeklyPct}%`);
    usageStateLabel = bits.join(' · ');
  }

  return {
    // session — raw
    status: state.status || 'idle',
    statusVerbose: statusVerbose(state.status, currentToolPretty, idleMs),
    idleMs,
    statusIcon: config?.statusIcons?.[state.status] || state.status || 'idle',
    project: projectPretty,
    projectPretty,
    cwd: safeCwd,
    model: state.model || 'claude',
    modelPretty,
    messages,
    tools,
    filesOpened,
    filesEdited,
    filesRead,
    // session tokens — defaults are grand total. Use *Real for in+out only.
    tokens: sessionTokens,
    tokensFmt: fmtNum(sessionTokens),
    tokensReal: sessionReal,
    tokensRealFmt: fmtNum(sessionReal),
    inputTokens: fmtNum(state.tokens?.input || 0),
    outputTokens: fmtNum(state.tokens?.output || 0),
    cacheTokens: fmtNum(sessionCacheRead + sessionCacheWrite),
    cacheReadTokens: fmtNum(sessionCacheRead),
    cacheWriteTokens: fmtNum(sessionCacheWrite),
    duration: fmtDuration(duration),
    durationHours: fmtHours(duration),
    currentTool: state.currentTool || '',
    currentToolPretty,
    currentFile: state.currentFile || '',
    currentFilePretty,

    // ── Subscription usage (v0.16) — what Claude Code's /usage shows ──
    usageSessionPct,
    usageWeeklyPct,
    usageWeeklyOpusPct: usage?.weeklyOpusPct ?? '',
    usageWeeklySonnetPct: usage?.weeklySonnetPct ?? '',
    usageSessionResets: usage ? fmtResetTime(usage.sessionResetsAt) : '',
    usageWeeklyResets: usage ? fmtResetDay(usage.weeklyResetsAt) : '',
    usageStateLabel,
    usagePlan: usage?.plan ? usage.plan.charAt(0).toUpperCase() + usage.plan.slice(1) : '',

    // ── File / directory / language (v0.3.6) ────────────────────
    fileName,
    fileExt,
    fileLang,
    fileLangUpper,
    dirName: dirNameOnly,
    fullDirName,

    // ── Git (v0.3.6) ────────────────────────────────────────────
    gitBranch,
    gitRepo,

    // ── App identity (v0.3.6) ───────────────────────────────────
    appName,

    // Literal single space — handy for blanking a line without `requires`.
    empty: ' ',

    // Pluralized session labels. tokensLabel is empty when zero so the
    // `· {tokensLabel}` suffix in default templates collapses away —
    // "Bash · · 0 tokens" is not a useful frame.
    tokensLabel: sessionTokens > 0 ? `${fmtNum(sessionTokens)} tokens` : '',
    messagesLabel: plural(messages, 'prompt'),
    toolsLabel: plural(tools, 'tool call'),
    filesEditedLabel: plural(filesEdited, 'edit'),
    filesReadLabel: plural(filesRead, 'file read'),
    filesOpenedLabel: plural(filesOpened, 'file'),

    // session lifecycle flag (for `requires` gating)
    sessionActive,

    // ── Tool-duration spotlight (v0.7) ──────────────────────────
    toolMs,
    toolElapsed,

    // ── Just-shipped (v0.7) ─────────────────────────────────────
    justShippedKind: state.justShippedKind || '',
    justShippedSubject: state.justShippedSubject || '',
    justShippedBranch: state.justShippedBranch || '',
    // Friendly headline for the largeImageText — "Pushed to main" or
    // "Committed to feat/x". Falls back to a verb-only label when no
    // branch is available (detached HEAD, sparse `.git`, etc.).
    justShippedLabel: state.justShippedKind === 'push'
      ? (state.justShippedBranch ? `Pushed to ${state.justShippedBranch}` : 'Pushed')
      : state.justShippedKind === 'commit'
        ? (state.justShippedBranch ? `Committed on ${state.justShippedBranch}` : 'Committed')
        : state.justShippedKind === 'pr'
          ? 'Opened a pull request'
          : state.justShippedKind === 'issue'
            ? 'Opened an issue'
            : state.justShippedKind === 'tag'
              ? (state.justShippedBranch ? `Tagged ${state.justShippedBranch}` : 'Tagged a release')
              : '',
    // {lastCommit} reads more naturally than {justShippedSubject} in user templates.
    lastCommit: state.justShippedSubject || '',

    // ── Compaction (v0.7) ───────────────────────────────────────
    compactMs,
    compactDuration: compactMs ? fmtDuration(compactMs) : '',
    compactTrigger,
    compactTriggerLabel,

    // concurrent / live
    concurrent,
    concurrentOther,
    concurrentLabel: plural(concurrent, 'live session'),
    concurrentOtherLabel: plural(concurrentOther, 'other session'),
    concurrentListPretty,

    // all-time tokens — defaults are grand total incl. cache reads.
    allTokens: allTotal,
    allTokensFmt: fmtNum(allTotal),
    allTokensReal: allReal,
    allTokensRealFmt: fmtNum(allReal),
    allBillable,
    allBillableFmt: fmtNum(allBillable),
    allInputTokens: fmtNum(agg.inputTokens || 0),
    allOutputTokens: fmtNum(agg.outputTokens || 0),
    allCacheTokens: fmtNum(allCache),
    allCacheReadTokens: fmtNum(allCacheRead),
    allCacheWriteTokens: fmtNum(allCacheWrite),
    // Fresh (input+output) vs cache breakdown — clarifies the lumped total so
    // "X tokens" isn't mistaken for billable spend (most of it is cheap cache).
    allFreshTokens: allReal,
    allFreshTokensFmt: fmtNum(allReal),
    allCachePct: allTotal > 0 ? Math.round((allCache / allTotal) * 100) : 0,
    allCachePctLabel: allTotal > 0 ? `${Math.round((allCache / allTotal) * 100)}% from cache` : '',
    // Model split (v0.9) — top model by spend + a compact share label.
    topModel: topModelEntry ? topModelEntry.model : '',
    topModelPretty: topModelEntry ? humanModel(topModelEntry.model) : '',
    topModelCostPct: topModelEntry ? Math.round((topModelEntry.costPct || 0) * 100) : 0,
    topModelShareLabel: topModelEntry && (topModelEntry.costPct || 0) > 0
      ? `${humanModel(topModelEntry.model)} · ${Math.round(topModelEntry.costPct * 100)}% of spend`
      : '',
    modelSplitLabel,
    allHours: fmtHours(agg.activeMs || 0),
    allWallHours: fmtHours(agg.wallMs || 0),
    allMessages: agg.userMessages || 0,
    allMessagesFmt: fmtNum(agg.userMessages || 0),
    allTools: agg.toolCalls || 0,
    allToolsFmt: fmtNum(agg.toolCalls || 0),
    allSessions: agg.sessions || 0,
    allSessionsLabel: plural(agg.sessions || 0, 'session'),
    allSubagentRuns: agg.subagentRuns || 0,
    allFiles: agg.uniqueFiles || 0,
    allFilesFmt: fmtNum(agg.uniqueFiles || 0),

    // today
    todayActiveMs: today.activeMs || 0,
    todayHours: fmtHours(today.activeMs || 0),
    todayPrompts: today.userMessages || 0,
    todayPromptsLabel: plural(today.userMessages || 0, 'prompt'),
    todayTools: today.toolCalls || 0,
    todayToolsFmt: fmtNum(today.toolCalls || 0),
    todayToolsLabel: plural(today.toolCalls || 0, 'tool call'),
    // today tokens — default is grand total incl. cache.
    todayTokens: todayTokensSum,
    todayTokensFmt: fmtNum(todayTokensSum),
    todayTokensReal: todayReal,
    todayTokensRealFmt: fmtNum(todayReal),
    todayCacheTokensFmt: fmtNum(todayCache),
    todaySessions: today.sessions || 0,

    // streak / lifetime
    streak,
    streakLabel: streak === 0 ? 'no streak' : `${streak}-day streak`,
    longestStreak: agg.longestStreak || 0,
    daysSinceFirst: agg.daysSinceFirst || 0,
    daysSinceFirstLabel: agg.daysSinceFirst ? `Day ${agg.daysSinceFirst}` : '',

    // best day
    bestDayDate: bestDay?.day || '',
    bestDayHours: bestDay ? fmtHours(bestDay.activeMs || 0) : '0h',
    bestDayPrompts: bestDay?.userMessages || 0,
    bestDayTokensFmt: bestDay
      ? fmtNum((bestDay.inputTokens || 0) + (bestDay.outputTokens || 0) + (bestDay.cacheReadTokens || 0) + (bestDay.cacheWriteTokens || 0))
      : '0',

    // This week
    weekActiveMs: thisWeek.activeMs || 0,
    weekHours: fmtHours(thisWeek.activeMs || 0),
    weekPrompts: thisWeek.userMessages || 0,
    weekPromptsLabel: plural(thisWeek.userMessages || 0, 'prompt'),
    weekTools: thisWeek.toolCalls || 0,
    weekToolsFmt: fmtNum(thisWeek.toolCalls || 0),
    weekToolsLabel: plural(thisWeek.toolCalls || 0, 'tool call'),
    weekTokens: weekTokensSum,
    weekTokensFmt: fmtNum(weekTokensSum),
    weekSessions: thisWeek.sessions || 0,
    weekSessionsLabel: plural(thisWeek.sessions || 0, 'session'),

    // Peak hour-of-day
    peakHourNum: peak?.hour ?? null,
    peakHour: peak ? fmtHour(peak.hour) : '',
    peakHourHours: peak ? fmtHours(peak.activeMs || 0) : '0h',
    peakHourActiveLabel: peak ? `${fmtHours(peak.activeMs || 0)} there` : '',

    // File hotspots
    topEditedFile: hotspot ? basename(hotspot.path) : '',
    topEditedCount: hotspot?.count || 0,
    topEditedCountLabel: hotspot ? plural(hotspot.count, 'edit') : '0 edits',
    // Hotspot aging — how long since the top file was last touched.
    topEditedDaysAgo: hotspot && hotspot.daysSinceLastEdit != null ? hotspot.daysSinceLastEdit : null,
    topEditedAgeLabel: !hotspot || hotspot.daysSinceLastEdit == null ? ''
      : hotspot.daysSinceLastEdit === 0 ? 'edited today'
      : hotspot.daysSinceLastEdit === 1 ? 'edited yesterday'
      : `${hotspot.daysSinceLastEdit}d since last edit`,

    // Per-project (current cwd's project)
    projectHours: projectStats ? fmtHours(projectStats.activeMs || 0) : '0h',
    projectActiveMs: projectStats?.activeMs || 0,
    projectPrompts: projectStats?.userMessages || 0,
    projectPromptsLabel: projectStats ? plural(projectStats.userMessages || 0, 'prompt') : '',
    projectTools: projectStats?.toolCalls || 0,
    projectSessions: projectStats?.sessions || 0,
    projectSessionLabel: projectStats ? `Session #${projectStats.sessions}` : '',

    // Streak milestone gate (for special rotation frame)
    streakIsMilestone,
    // Session-duration milestone gate + label (v0.9)
    sessionMilestoneHit,
    sessionMilestoneLabel,

    // ── Code churn ───────────────────────────────────────────────
    linesAdded: allLinesAdded,
    linesAddedFmt: fmtNum(allLinesAdded),
    linesRemoved: allLinesRemoved,
    linesRemovedFmt: fmtNum(allLinesRemoved),
    linesNet: allLinesNet,
    linesNetFmt: fmtLinesNet(allLinesNet),
    todayLinesAdded,
    todayLinesAddedFmt: fmtNum(todayLinesAdded),
    todayLinesRemoved,
    todayLinesRemovedFmt: fmtNum(todayLinesRemoved),
    todayLinesNet,
    todayLinesNetFmt: fmtLinesNet(todayLinesNet),
    weekLinesAdded,
    weekLinesAddedFmt: fmtNum(weekLinesAdded),
    weekLinesNet,
    weekLinesNetFmt: fmtLinesNet(weekLinesNet),
    allLinesAdded,
    allLinesAddedFmt: fmtNum(allLinesAdded),
    allLinesNet,
    allLinesNetFmt: fmtLinesNet(allLinesNet),

    // ── Languages ────────────────────────────────────────────────
    topLanguage: topLang ? topLang[0] : '',
    topLanguageEdits: topLang ? (topLang[1].edits || 0) : 0,
    topLanguageEditsFmt: topLang ? fmtNum(topLang[1].edits || 0) : '0',
    languagesLabel,

    // ── Bash commands ────────────────────────────────────────────
    topBashCmd: topBash ? topBash.k : '',
    topBashCmdCount: topBash ? topBash.v : 0,
    topBashCmdLabel: topBash ? `${topBash.k} × ${fmtNum(topBash.v)}` : '',

    // ── WebFetch domains ────────────────────────────────────────
    topDomain: topDomain ? topDomain.k : '',
    topDomainCount: topDomain ? topDomain.v : 0,
    topDomainLabel: topDomain ? `${topDomain.k} × ${fmtNum(topDomain.v)}` : '',

    // ── Subagents ───────────────────────────────────────────────
    topSubagent: topSubagent ? topSubagent.k : '',
    topSubagentCount: topSubagent ? topSubagent.v : 0,
    subagentLabel: topSubagent ? `${topSubagent.k} × ${fmtNum(topSubagent.v)}` : '',

    // ── Tool surface split ──────────────────────────────────────
    mcpToolCalls: mcpCalls,
    mcpToolCallsFmt: fmtNum(mcpCalls),
    builtinToolCalls: builtinCalls,
    builtinToolCallsFmt: fmtNum(builtinCalls),
    mcpToolPercent: mcpPct,
    mcpToolPercentLabel: totalToolCalls ? `${mcpPct}% MCP` : '',

    // ── Cost ────────────────────────────────────────────────────
    todayCost,
    todayCostFmt: fmtCost(todayCost),
    weekCost,
    weekCostFmt: fmtCost(weekCost),
    allCost,
    allCostFmt: fmtCost(allCost),
    costEstimate: allCost,
    costEstimateFmt: fmtCost(allCost),
    projectCost,
    projectCostFmt: fmtCost(projectCost),

    // ── Goals & budget (v0.10) ──────────────────────────────────
    goalLabel,
    goalHit,
    goalDailyHoursPct,
    goalDailyPromptsPct,
    goalWeeklyHoursPct,
    budgetLabel,
    budgetPct,
    budgetWarn,
    budgetMtdFmt: fmtCost(mtdCost),

    // ── Time-of-day / weekday ───────────────────────────────────
    weekdayLabel,
    startTimeLabel: todayStartLabel,

    // ── Notifications ───────────────────────────────────────────
    notificationCount,
    notificationLabel: notificationCount ? plural(notificationCount, 'notification') : '',
  };
}

export function fillTemplate(tpl, vars) {
  if (typeof tpl !== 'string') return tpl;
  const filled = tpl.replace(/\{(\w+)\}/g, (_, key) => (key in vars ? String(vars[key]) : `{${key}}`));
  return collapseSeparators(filled);
}

// After substitution, a template like "{currentToolPretty} · {currentFilePretty} · {tokensFmt} tokens"
// can resolve to "Bash ·  · 0 tokens" when the tool doesn't have a file path
// and no tokens have accumulated yet. Split on `·`, trim each segment, drop
// empty segments, rejoin — so empty middle vars don't leave orphan separators
// and trailing/leading separators disappear entirely. Templates without `·`
// pass through untouched.
function collapseSeparators(s) {
  if (!s.includes('·')) return s;
  return s.split('·').map((p) => p.trim()).filter(Boolean).join(' · ');
}

// Helper used by every "go stale" branch in applyIdle. Wipes the current-
// activity slots so rotation frames can't render yesterday's project /
// file / tool names, and zeroes the session counters that are tied to
// the now-dead session.
function staleWipe(state) {
  return {
    ...state,
    status: 'stale',
    currentTool: null,
    currentFile: null,
    sessionStart: null,
    cwd: '',
    messages: 0,
    tools: 0,
    filesOpened: [],
    filesEdited: [],
    filesRead: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

// A live transcript is being written by a session whose hooks don't feed THIS
// daemon (a sibling, or a session that out-lived a SessionEnd). The user IS
// working — adopt the most-recent live session as our 'working' context, zeroing
// the old session's hook-derived counters since they belong to the quiet one.
function borrowLiveSession(state, liveSessions, now) {
  const recent = liveSessions[0] || {};
  return {
    ...state,
    status: 'working',
    // sessionStart here is a moving transcript mtime, not a real anchor — the
    // flag lets the daemon pin its elapsed timer to the first observation
    // instead of restarting it every 30s refresh.
    borrowed: true,
    cwd: recent.cwd || state.cwd || '',
    sessionStart: recent.mtime || now,
    lastActivity: recent.mtime || now,
    currentTool: null,
    currentFile: null,
    messages: 0,
    tools: 0,
    filesOpened: [],
    filesEdited: [],
    filesRead: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

// Apply idle/stale transitions based on lastActivity age. Used by both daemon
// and the `preview` CLI command so they agree.
//
// Important: state.liveSessions (set by the caller from findLiveSessions) is
// the ground truth for "is the user active anywhere right now?". The local
// state.json only knows about hook-driven activity in this exact daemon
// instance, so we trust on-disk transcript mtimes over a stale state.json.
export function applyIdle(state, cfg = {}) {
  const liveSessions = state.liveSessions || [];
  const last = state.lastActivity || 0;
  const now = Date.now();
  const ageMs = now - last;
  const idleMs = (cfg.idleThresholdSec || 60) * 1000;
  const staleMs = Math.max(60_000, (cfg.staleSessionMin || 5) * 60 * 1000);
  const notificationMs = (cfg.notificationWindowSec || 8) * 1000;
  // Closing the terminal kills Claude Code without firing SessionEnd, so the
  // only passive "is it gone?" signal is "no transcript is being written".
  // DEFAULT (false): clear the card within ~90-120s of the transcript going
  // quiet — a closed terminal shouldn't leave a card up for 5 minutes. Opt in
  // with idleWhenOpen:true to instead linger as 'idle' until the staleMs
  // backstop (keeps the card up through short pauses with the terminal open).
  const idleWhenOpen = cfg.idleWhenOpen === true;

  // Most-recent disk-level activity across ALL transcripts we can see. Computed
  // before the close check so it can defer to a live sibling.
  const mostRecentLiveMs = liveSessions.length
    ? Math.max(...liveSessions.map((s) => s.mtime || 0))
    : 0;
  const liveAgeMs = mostRecentLiveMs ? now - mostRecentLiveMs : Infinity;

  // Authoritative close signal from the SessionEnd hook — trust it instead of
  // waiting on staleSessionMin. BUT state.json is global: a SessionEnd from ONE
  // session must not blank the card while a SIBLING is mid-work. A sibling is
  // alive iff a live transcript in a DIFFERENT cwd than the one that just closed
  // (still in state.cwd) is fresh — adopt it. The just-closed session's own
  // transcript is briefly still fresh, so it must NOT keep the card up; anything
  // but a distinct live sibling wipes. (A's next hook also clears the flag.)
  //
  // Known limitation: the inverse — B's SessionStart resetState briefly showing
  // idle over A's work — isn't fully fixed here (the hook can't see live
  // transcripts); it self-heals on A's next hook. See MEMORY/SECURITY notes.
  if (state.claudeClosed) {
    const sibling = liveSessions.find((s) => s.cwd && s.cwd !== state.cwd && now - (s.mtime || 0) <= staleMs);
    return sibling ? borrowLiveSession(state, [sibling], now) : staleWipe(state);
  }

  // Notification is a brief status — hold it for ~8s after the hook fires,
  // then fall through to normal idle/stale processing.
  if (state.status === 'notification') {
    const notifAge = now - (state.lastNotification || 0);
    if (notifAge <= notificationMs) return state;
    // Going idle after a notification — wipe the current-activity slots so idle
    // frames don't render stale file/tool names (same as the idle path below).
    state = { ...state, status: 'idle', currentTool: null, currentFile: null, filesOpened: [], filesEdited: [], filesRead: [] };
  }

  // Truly dormant: no live transcripts AND local state is old → stale.
  if (ageMs > staleMs && liveAgeMs > staleMs) return staleWipe(state);

  // Local state is stale but a live transcript exists somewhere on disk.
  // Borrow the most-recent live session as our "active" context, since the
  // user clearly IS working — just not in a session whose hooks feed us.
  if (ageMs > staleMs && liveAgeMs <= staleMs) {
    return borrowLiveSession(state, liveSessions, now);
  }

  // Local state is fresh.
  if (state.status === 'idle') {
    // No transcripts being written anywhere on disk — Claude Code may have
    // closed without a SessionEnd hook (force-quit, OS sleep, crash). By
    // default (idleWhenOpen=false) go straight to stale so a closed terminal
    // clears the card within ~90-120s of the last write. Opt in with
    // idleWhenOpen:true to keep showing 'idle' through short pauses; the
    // staleMs dormancy backstop above still clears it if Claude is truly gone.
    if (liveSessions.length === 0 && !idleWhenOpen) return staleWipe(state);
    return state;
  }
  if (ageMs > idleMs) {
    // Hook channel is quiet, but a live transcript was modified recently?
    // Keep "working" instead of dropping to "idle".
    if (liveAgeMs <= idleMs) return state;
    // Hooks quiet AND no live transcripts. By default (idleWhenOpen=false)
    // treat Claude as gone and go stale now. With idleWhenOpen:true the
    // session is treated as open-but-paused and drops to idle; the staleMs
    // backstop above clears it later if Claude actually exited.
    if (liveSessions.length === 0 && !idleWhenOpen) return staleWipe(state);
    // Going idle — wipe "current activity" indicators so rotation frames
    // gated on filesEdited / currentFile / currentTool stop showing stale
    // active-session data. Keep the session counters (messages/tools/tokens)
    // since those still make sense as "this session so far". The cwd stays
    // so frames can still say "Idle in <project>".
    return {
      ...state,
      status: 'idle',
      currentTool: null,
      currentFile: null,
      filesOpened: [],
      filesEdited: [],
      filesRead: [],
    };
  }
  return state;
}

// Promote status to 'shipped' for a brief celebratory window after a
// `git push` / `git commit` is observed. Called by the daemon AFTER
// applyIdle — stale/idle decisions still take precedence over the shipped
// overlay (we don't celebrate when Claude isn't running). The window is
// configurable via `shippedFrameSec` (default 60).
//
// Pure: returns a new state object when promoting, the input otherwise.
// The underlying `state.status` is untouched so the daemon falls back
// cleanly once the window expires.
export function applyShipped(state, cfg = {}) {
  if (!state.justShipped) return state;
  if (state.status === 'stale') return state;
  const windowMs = Math.max(5_000, (cfg.shippedFrameSec ?? 60) * 1000);
  const age = Date.now() - state.justShipped;
  if (age < 0 || age > windowMs) return state;
  return { ...state, status: 'shipped' };
}

// Overlay a custom-trigger frame when a recent Bash command matches a
// user-defined pattern (config.triggers: [{ match, details, state }]). Called
// by the daemon AFTER applyIdle/applyShipped — never overrides stale or the
// shipped celebration. Window = triggerFrameSec (default 20s) from the command.
// Returns a new state with status:'trigger' + _triggerFrame, or the input.
export function applyTrigger(state, cfg = {}) {
  const triggers = Array.isArray(cfg.triggers) ? cfg.triggers : [];
  if (!triggers.length) return state;
  if (state.status === 'stale' || state.status === 'shipped') return state;
  const cmd = state.lastBashCommand || '';
  if (!cmd) return state;
  const windowMs = Math.max(3_000, (cfg.triggerFrameSec ?? 20) * 1000);
  if (Date.now() - (state.lastBashAt || 0) > windowMs) return state;
  for (const t of triggers) {
    if (!t || !t.match) continue;
    let re;
    try { re = new RegExp(t.match, 'i'); } catch { continue; }
    if (re.test(cmd)) {
      return {
        ...state,
        status: 'trigger',
        _triggerFrame: {
          details: t.details || '{statusVerbose} in {project}',
          state: t.state || '',
          largeImageText: t.largeImageText || null,
        },
      };
    }
  }
  return state;
}

// True when `requires` (string or array of strings) all resolve to non-zero / non-empty.
export function framePasses(frame, vars) {
  const req = frame.requires;
  if (!req) return true;
  const keys = Array.isArray(req) ? req : [req];
  for (const k of keys) {
    const v = vars[k];
    if (v === undefined || v === null || v === 0 || v === '' || v === '—' || v === '0') return false;
  }
  return true;
}

export { fmtNum, fmtDuration, fmtHours, fmtToolElapsed, humanModel, humanTool, humanProject, plural };
