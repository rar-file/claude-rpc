// The one table of CLI commands. `help`, `help <command>`, tab completion
// (`__complete`) and the "did you mean" hint all read it, so a command, flag
// or sub-command added here shows up in all four at once. Dispatch itself
// stays in cli.js's switch; test/commands.test.js fails when the two drift.
//
// Shape of an entry:
//   name     what you type
//   group    help section (GROUPS order); omitted → hidden from help + completion
//   summary  one line for the list
//   usage    argument synopsis after the name ('' when none)
//   subs     [name, summary] positional choices for the first argument
//   flags    [flag, summary, values?] — values: an array, 'file', 'project' or
//            'any' (takes a free-form value); no values → boolean switch
//   aliases  older names that still work (stable per VERSIONING.md), not listed
//   examples shown by `help <command>`
//
// Pure data + pure helpers: no fs, no imports from the core graph — the
// completion path loads this on every <Tab>.

export const GROUPS = [
  ['start', 'Get started'],
  ['stats', 'Your stats'],
  ['share', 'Share'],
  ['privacy', 'Privacy'],
  ['online', 'Online'],
  ['daemon', 'Daemon'],
  ['fix', 'Troubleshoot'],
];

const METRICS = ['hours', 'tokens', 'streak', 'sessions'];
const RANGES = ['week', 'month', 'year', 'all'];
export const SHELLS = ['bash', 'zsh', 'fish', 'powershell'];

export const COMMANDS = [
  // ── Get started ──
  { name: 'setup', group: 'start', summary: 'Hook into Claude Code and start the card — run once',
    flags: [['--link', 'Also verify this machine with a claude-rpc.com code', 'any'],
            ['--wrapped', 'With --link: publish your year-in-review too']],
    aliases: ['install'],
    examples: ['claude-rpc setup', 'claude-rpc setup --link ABCD-1234 --wrapped'] },
  { name: 'completion', group: 'start', summary: 'Tab completion for your shell', usage: '[install|uninstall|<shell>]',
    subs: [['install', 'Turn it on for your shell (asks nothing else)'], ['uninstall', 'Turn it off'],
           ...SHELLS.map((s) => [s, `Print the ${s} script`])],
    examples: ['claude-rpc completion install', 'claude-rpc completion zsh > ~/.zfunc/_claude-rpc'] },
  { name: 'uninstall', group: 'start', summary: 'Undo setup (keeps your config and stats)' },

  // ── Your stats ──
  { name: 'status', group: 'stats', summary: 'Live stats dashboard in the terminal',
    flags: [['--dump', 'Print once as plain text (also when piped)']], aliases: ['dump'] },
  { name: 'today', group: 'stats', summary: 'Today, plus when in the day you code' },
  { name: 'week', group: 'stats', summary: 'This week day by day',
    flags: [['--compare', 'Side by side with last week']], aliases: ['compare'],
    examples: ['claude-rpc week', 'claude-rpc week --compare'] },
  { name: 'projects', group: 'stats', summary: 'Projects ranked by time — or one project in detail', usage: '[name]',
    args: 'project', flags: [['--limit', 'How many to list (default 12)', 'any']], aliases: ['project'],
    examples: ['claude-rpc projects', 'claude-rpc projects claude-rpc'] },
  { name: 'usage', group: 'stats', summary: 'Plan limits: session and weekly % used' },
  { name: 'recap', group: 'stats', summary: 'Standup summary (yesterday by default)', usage: '[today|yesterday|week|YYYY-MM-DD]',
    subs: [['yesterday', 'Default — Monday covers Friday'], ['today', 'So far today'], ['week', 'This week']],
    flags: [['--md', 'Paste-ready markdown'], ['--json', 'Raw numbers']],
    examples: ['claude-rpc recap', 'claude-rpc recap week --md'] },
  { name: 'insights', group: 'stats', summary: 'Patterns spotted in your history' },
  { name: 'wrapped', group: 'stats', summary: 'Your animated year in review',
    flags: [['--publish', 'Put it on claude-rpc.com/wrapped/<handle>'], ['--year', 'Which year', 'any'], ['--yes', 'Skip the confirm']] },
  { name: 'serve', group: 'stats', summary: 'Open the live web dashboard' },
  { name: 'export', group: 'stats', summary: 'Everything as JSON, or daily rows as CSV',
    flags: [['--csv', 'Daily rows as CSV'], ['--out', 'Write to a file', 'file']] },

  // ── Share ──
  { name: 'statcards', group: 'share', summary: 'Cards and badges as a live link, PNG or SVG', usage: '[card]',
    subs: [['stats', 'Stats + year heatmap'], ['profile', 'Profile card'], ['badge', 'Small badge'],
           ['heatmap', 'Year heatmap'], ['poster', 'Poster summary'], ['session', 'This session'],
           ['wrapped', 'Year-in-review card'], ['list', 'What each card is and where it can go']],
    flags: [['--link', 'Live, self-updating URL (needs a public profile)'], ['--png', 'Save a PNG (optional path)', 'file'],
            ['--svg', 'Save an SVG (optional path)', 'file'], ['--md', 'With --link: print Markdown'],
            ['--html', 'With --link: print an <img> tag'], ['--metric', 'What a badge/heatmap counts', METRICS],
            ['--range', 'Window for badge/poster', RANGES], ['--copy', 'Copy the snippet to the clipboard']],
    aliases: ['badge', 'card', 'github-stat', 'calendar', 'session-card', 'readme'],
    examples: ['claude-rpc statcards', 'claude-rpc statcards stats --link --md', 'claude-rpc statcards poster --png', 'claude-rpc statcards badge --metric streak --svg streak.svg'] },
  { name: 'statusline', group: 'share', summary: 'One-line status for tmux and shell prompts',
    flags: [['--template', 'Template using any `claude-rpc vars` name', 'any']] },
  { name: 'mcp', group: 'share', summary: 'Let Claude read your stats (MCP server)', usage: '[install|uninstall]',
    subs: [['install', 'Wire it into Claude Code'], ['uninstall', 'Remove it']] },

  // ── Privacy ──
  { name: 'private', group: 'privacy', summary: 'Hide this folder from Discord — or show it again', usage: '[on|off|status]',
    subs: [['on', 'Hide this folder (default)'], ['off', 'Show it again'], ['status', 'What Discord sees for this folder']],
    aliases: ['public', 'privacy'],
    examples: ['claude-rpc private', 'claude-rpc private off', 'claude-rpc private status'] },
  { name: 'pause', group: 'privacy', summary: 'Hide the card everywhere for a while (default 1h)', usage: '[30m|2h|off|status]',
    subs: [['30m', '30 minutes'], ['1h', 'An hour'], ['2h', 'Two hours'], ['off', 'Show the card again'], ['status', 'Paused?']],
    aliases: ['resume', 'unpause'],
    examples: ['claude-rpc pause 2h', 'claude-rpc pause off'] },

  // ── Online ──
  { name: 'profile', group: 'online', summary: 'Your public leaderboard profile', usage: '[status|set|on|off|publish|verify]',
    subs: [['status', 'Show it'], ['set', 'Change handle / name / github'], ['on', 'Go public'], ['off', 'Go private'],
           ['publish', 'Push your numbers now'], ['verify', 'Prove the GitHub account is yours']],
    flags: [['--handle', 'With set: your handle', 'any'], ['--name', 'With set: display name', 'any'], ['--github', 'With set: GitHub login', 'any']] },
  { name: 'squad', group: 'online', summary: 'Private leaderboards with friends', usage: '[status|create|join|leave]',
    subs: [['status', 'Your squads'], ['create', 'Start one'], ['join', 'Join with a code'], ['leave', 'Leave one']] },
  { name: 'link', group: 'online', summary: 'Join machines into one profile', usage: '[code]' },
  { name: 'community', group: 'online', summary: 'Anonymous community totals', usage: '[status|on|off|report]',
    subs: [['status', 'Show it'], ['on', 'Opt in'], ['off', 'Opt out'], ['report', 'Send now']] },

  { name: 'update', group: 'daemon', summary: 'Check for a new version (and auto-update)', usage: '[check|now|on|off|status]',
    subs: [['check', 'Look for a newer release'], ['now', 'Install it now'], ['on', 'Auto-update (default)'], ['off', 'Never update unattended'], ['status', 'Show settings']] },

  // ── Daemon ──
  { name: 'start', group: 'daemon', summary: 'Start the Discord daemon' },
  { name: 'stop', group: 'daemon', summary: 'Stop it' },
  { name: 'restart', group: 'daemon', summary: 'Restart it and wait until it is up' },
  { name: 'logs', group: 'daemon', summary: 'Follow the daemon log', aliases: ['tail', 'log'] },

  // ── Troubleshoot ──
  { name: 'doctor', group: 'fix', summary: 'Check everything; --fix repairs what it can',
    flags: [['--fix', 'Apply the repairs']] },
  { name: 'scan', group: 'fix', summary: 'Re-count your history from transcripts',
    flags: [['--force', 'Re-parse everything, ignore the cache']], aliases: ['rescan'] },
  { name: 'backfill', group: 'fix', summary: 'Import transcripts from a backup or another machine', usage: '<dir>', args: 'file' },
  { name: 'preview', group: 'fix', summary: 'How every card frame renders right now' },
  { name: 'vars', group: 'fix', summary: 'Every template variable and its live value (JSON)' },
  { name: 'upgrade-config', summary: 'Re-run config migrations' },
  { name: 'daemon', summary: 'Run the daemon in the foreground (debug)' },
  { name: 'help', summary: 'This screen, or one command in detail', usage: '[command]', args: 'command' },
];

// Internal entry points the dispatcher knows but nobody types.
export const INTERNAL = ['hook', 'scan-worker', '__complete', '--version', '-V', '-v', '--help', '-h'];

const BY_NAME = new Map();
for (const cmd of COMMANDS) {
  BY_NAME.set(cmd.name, cmd);
  for (const a of cmd.aliases || []) BY_NAME.set(a, cmd);
}

// The command entry for a name or any alias, or null.
export function findCommand(name) {
  return BY_NAME.get(name) || null;
}

// Every name the dispatcher must accept: commands, aliases, internals.
export function allNames() {
  return [...BY_NAME.keys(), ...INTERNAL];
}

export function visibleCommands() {
  return COMMANDS.filter((c) => c.group);
}

// Damerau-free Levenshtein, small strings only.
function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// What each older name now spells, for `help <old>` and typo hints.
export const ALIAS_HINT = {
  install: 'setup', dump: 'status --dump', compare: 'week --compare', project: 'projects <name>',
  rescan: 'scan --force', resume: 'pause off', unpause: 'pause off', public: 'private off',
  privacy: 'private status', tail: 'logs', log: 'logs', badge: 'statcards badge', card: 'statcards poster',
  'github-stat': 'statcards profile', calendar: 'statcards heatmap', 'session-card': 'statcards session',
  readme: 'statcards stats --link',
};

// "did you mean" for an unknown command: a unique prefix match first
// (`stat` is ambiguous, `statc` → statcards), else the closest name within 2
// edits. Older names count too, so muscle memory still gets a hint — the hint
// is the name that matched, which still works.
export function suggestCommand(input) {
  const s = String(input || '').toLowerCase();
  if (!s) return null;
  const names = [...BY_NAME.keys()];
  const prefixed = names.filter((n) => n.startsWith(s));
  if (prefixed.length && new Set(prefixed.map((n) => BY_NAME.get(n).name)).size === 1) {
    return prefixed.sort((a, b) => a.length - b.length)[0];
  }
  let best = null;
  let bestD = 3;
  for (const n of names) {
    const d = distance(s, n);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

// ── completion ───────────────────────────────────────────────────────────
//
// complete(words, ctx) → candidate lines, each "value" or "value\tdescription".
// `words` are the args after `claude-rpc`, the last one being the word under
// the cursor (possibly ''). A lone '__files__' line asks the shell to fall back
// to file-name completion. ctx.projects() lazily supplies project names.

export const FILES = '__files__';

function matching(pairs, cur) {
  return pairs.filter(([v]) => v.startsWith(cur)).map(([v, d]) => (d ? `${v}\t${d}` : v));
}

function valueCandidates(kind, cur, ctx) {
  if (kind === 'file') return [FILES];
  if (kind === 'project') return matching((ctx.projects?.() || []).map((p) => [p, '']), cur);
  if (kind === 'command') return matching(visibleCommands().map((c) => [c.name, c.summary]), cur);
  if (Array.isArray(kind)) return matching(kind.map((v) => [v, '']), cur);
  return [];
}

export function complete(words, ctx = {}) {
  const w = words.length ? words : [''];
  const cur = w[w.length - 1];
  if (w.length === 1) return matching(visibleCommands().map((c) => [c.name, c.summary]), cur);

  const cmd = findCommand(w[0]);
  if (!cmd) return [];
  const flags = cmd.flags || [];
  const prev = w[w.length - 2];

  // Value for the flag just typed (`--metric <Tab>`).
  const flag = flags.find(([f]) => f === prev);
  if (flag && flag[2] && !cur.startsWith('-')) return valueCandidates(flag[2], cur, ctx);

  if (cur.startsWith('-')) {
    const used = new Set(w.slice(1, -1));
    return matching(flags.filter(([f]) => !used.has(f)).map(([f, d]) => [f, d]), cur);
  }

  // First positional → the command's sub-commands or argument values.
  const positionals = w.slice(1, -1).filter((x, i, arr) => {
    if (x.startsWith('-')) return false;
    const before = i > 0 ? arr[i - 1] : w[0];
    const f = flags.find(([name]) => name === before);
    return !(f && f[2]);
  });
  if (positionals.length === 0) {
    if (cmd.subs) return matching(cmd.subs, cur);
    if (cmd.args) return valueCandidates(cmd.args, cur, ctx);
  }
  return [];
}
