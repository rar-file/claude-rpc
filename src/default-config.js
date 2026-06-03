// Inlined default config used to seed <USER_CONFIG_DIR>/config.json on first
// install. Kept in sync with config.example.json. Inlining (rather than
// bundling the JSON as an asset) keeps the build pipeline simple and works
// with both pkg and Node SEA without asset APIs.
//
// v0.3.6 shape:
//   presence.byStatus.<status> — fixed template per status (the "VSCode-RPC
//   style" main view). Each entry may optionally include a `rotation` array
//   that cycles AFTER the base frame. Backwards-compat: a config without
//   byStatus still works — the legacy top-level `presence.rotation` is used.

export const DEFAULT_CONFIG = {
  clientId: "1506443909406920948",
  appName: "Claude Code",
  updateIntervalMs: 4000,
  rotationIntervalMs: 12000,
  rescanIntervalSec: 300,
  idleThresholdSec: 60,
  // Time (minutes) of no hook activity AND no live transcripts on disk before
  // the daemon treats Claude Code as "not running". Kept short on purpose:
  // when Claude isn't open, the Discord presence should disappear quickly.
  // The SessionEnd hook short-circuits this — see hook.js + format.applyIdle.
  staleSessionMin: 5,
  // Closing the terminal kills Claude Code without firing its SessionEnd hook,
  // so the daemon can't tell "closed" from "paused" — it only sees the
  // transcript stop. Default false: clear the card ~90-120s after the
  // transcript goes quiet, so a closed terminal doesn't leave a stale card up.
  // Set true to instead linger as 'idle' until staleSessionMin (keeps the card
  // up through short pauses, at the cost of a closed terminal showing idle for
  // up to staleSessionMin minutes before clearing).
  idleWhenOpen: false,
  // When true, the daemon CLEARS Discord activity entirely once the state
  // goes stale — your profile shows nothing instead of an "Away" frame.
  hideWhenStale: true,
  notificationWindowSec: 8,
  // How long after a `git push` / `git commit` the card stays on the
  // celebratory "Just shipped" frame before falling back to the
  // underlying status. Set 0 to disable the overlay entirely.
  shippedFrameSec: 60,
  // Daily / weekly goals (v0.10). When set (> 0), the daemon surfaces a
  // progress frame ("2.1h / 4h · 52%") and the dashboard shows a ring.
  // Set any field to 0/null to disable that goal.
  goals: {
    dailyHours: 0,     // target active hours per day
    dailyPrompts: 0,   // target prompts per day
    weeklyHours: 0,    // target active hours per week
  },
  // Monthly cost budget (v0.10). When budget.monthly > 0, the dashboard and
  // a presence frame warn as month-to-date spend approaches it.
  budget: {
    monthly: 0,        // USD; 0 disables
    warnAtPct: 80,     // surface a warning once MTD spend hits this %
  },
  // Outbound status webhook (v0.10). When url is set, the daemon POSTs a small
  // JSON body on status transitions you opt into (best-effort, fire-and-forget).
  // Pair with a Slack/Discord incoming-webhook or your own endpoint.
  webhook: {
    url: "",                                  // "" disables
    on: ["shipped", "notification"],          // statuses that fire a POST
  },
  // Desktop notifications (v0.10). When enabled, the daemon raises a native OS
  // notification (notify-send / osascript / PowerShell toast) when Claude needs
  // you — so a permission prompt isn't missed while you're tabbed away.
  notify: {
    enabled: false,
    onNotification: true,   // raise on the Notification hook
  },
  // Custom command triggers (v0.10). Each entry maps a regex against the Bash
  // command Claude runs to a brief presence frame, generalizing ship-detection.
  // e.g. { "match": "npm (run )?test", "details": "Running tests in {project}" }
  triggers: [],
  // How long (seconds) a matched trigger frame stays up after the command ran.
  triggerFrameSec: 20,
  // `claude-rpc badge --gist` records id+owner here after a successful
  // first publish so subsequent publishes UPDATE the same gist (the raw
  // URL in your README stays stable). filename is the file inside the
  // gist — change it only if you publish multiple badges to one gist.
  gist: {
    id: null,
    owner: null,
    filename: "claude.svg",
    public: true,
  },
  // Community totals. On by default for fresh installs — `setup` mints an
  // anonymous instanceId (UUID v4) into the freshly-seeded config so the
  // daemon starts batching deltas immediately. Existing users upgrading
  // from a version without this block keep their old behavior: migrateConfig
  // writes `community.enabled: false` into their file, and the consent flow
  // at `claude-rpc community on` is the only path to enable. Opt out at any
  // time with `claude-rpc community off`. See worker/src/index.js for the
  // receiving end and exactly what payload is accepted (the validator there
  // is the schema of record).
  community: {
    enabled: true,
    instanceId: null,
    endpoint: "https://claude-rpc-totals.claude-rpc.workers.dev",
    flushIntervalMin: 30,
  },
  showElapsed: true,
  activityType: 0,
  statusAssets: {
    working:      "https://cdn.qualit.ly/clawd-working-building.gif",
    thinking:     "https://cdn.qualit.ly/clawd-working-typing.gif",
    compacting:   "https://cdn.qualit.ly/clawd-working-typing.gif",
    shipped:      "https://cdn.qualit.ly/clawd-working-building.gif",
    idle:         "https://cdn.qualit.ly/clawd-sleeping.gif",
    stale:        "https://cdn.qualit.ly/clawd-sleeping.gif",
    notification: "https://cdn.qualit.ly/clawd-notification.gif",
  },
  presence: {
    largeImageKey: "https://cdn.qualit.ly/clawd-sleeping.gif",
    // Tooltip used when a status doesn't supply its own largeImageText.
    // The lifetime "credentials" line that travels with every status.
    largeImageText: "{modelPretty} · {allHours} on Claude · {streakLabel}",
    smallImageKey: "{statusIcon}",
    smallImageText: "{statusVerbose}",

    // Status-driven templates. Each status renders a fixed "what's happening
    // right now" frame. Only `idle` carries an inner rotation — that's where
    // the lifetime stats cycle through.
    byStatus: {
      working: {
        details: "Working in {project}",
        state:   "{currentToolPretty} · {currentFilePretty} · {toolElapsed} · {tokensLabel}",
        largeImageText: "Working on a {fileLang} file",
        rotation: [
          // Pops in for ~5min when the session crosses an hour milestone, then
          // the `requires` gate drops it and we're back to the single frame.
          { details: "{sessionMilestoneLabel} · {project}", state: "{tokensLabel} · {messagesLabel}", requires: ["sessionMilestoneHit"] },
        ],
      },
      thinking: {
        details: "Thinking in {project}",
        state:   "{modelPretty} · {messagesLabel} · {tokensLabel}",
        largeImageText: "Reasoning with {modelPretty}",
      },
      compacting: {
        details: "Compacting context in {project}",
        state:   "{modelPretty} · {messagesLabel}",
        largeImageText: "Compacting · {compactTriggerLabel}",
      },
      shipped: {
        // {justShippedLabel} adapts to the action: "Pushed to main",
        // "Committed on feat/x", "Opened a pull request", "Opened an issue".
        details: "{justShippedLabel} · {project}",
        state:   "{lastCommit}",
        largeImageText: "{justShippedLabel}",
      },
      notification: {
        details: "Waiting on you · {project}",
        state:   "{modelPretty} · {messagesLabel}",
        largeImageText: "Permission needed",
      },
      idle: {
        details: "Idle in {project}",
        state:   "{modelPretty} · {todayHours} today",
        largeImageText: "Idle · {modelPretty}",
        rotation: [
          { details: "This week · {weekHours}",                state: "{weekPromptsLabel} · {weekTokensFmt} tokens", requires: ["weekActiveMs"] },
          { details: "{streakLabel}",                          state: "{daysSinceFirstLabel} · {allSessionsLabel}",  requires: ["streakIsMilestone"] },
          { details: "Hotspot · {topEditedFile}",              state: "{topEditedCountLabel} · {topEditedAgeLabel}", requires: ["topEditedCount"] },
          { details: "Model split",                            state: "{modelSplitLabel}",                          requires: ["modelSplitLabel"] },
          { details: "{allHours} on Claude all-time",          state: "{allSessionsLabel} · {allMessagesFmt} prompts", requires: ["allSessions"] },
          { details: "Lifetime · {allTokensFmt} tokens",       state: "{allToolsFmt} tool calls · {allFilesFmt} files", requires: ["allTools"] },
          { details: "{allFreshTokensFmt} fresh tokens",       state: "{allCachePctLabel}",                         requires: ["allCachePctLabel"] },
          { details: "Code churn · {linesAddedFmt} added",     state: "{linesNetFmt} net · {topLanguage}",            requires: ["topLanguage"] },
          { details: "Cost · {todayCostFmt} today",            state: "{allCostFmt} all-time",                        requires: ["allCost"] },
          { details: "Daily goal",                             state: "{goalLabel}",                                  requires: ["goalLabel"] },
          { details: "Monthly budget",                         state: "{budgetLabel}",                                requires: ["budgetLabel"] },
        ],
      },
    },

    buttons: [
      // The card others see in Discord is the project's main distribution
      // surface — make the button a real call-to-action, not a bare repo link.
      // ?ref=discord lets the landing page attribute installs that originate
      // from a presence card. (When the cwd is a github repo the daemon also
      // prepends a "View on GitHub →" button, so both can show.)
      { label: "Get claude-rpc →", url: "https://claude-rpc.vercel.app/?ref=discord" },
    ],
  },
  statusIcons: {
    working:      "working",
    thinking:     "thinking",
    compacting:   "thinking",
    shipped:      "working",
    idle:         "idle",
    notification: "",
    stale:        "",
  },
};
