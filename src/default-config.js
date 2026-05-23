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
  // When true, the daemon CLEARS Discord activity entirely once the state
  // goes stale — your profile shows nothing instead of an "Away" frame.
  hideWhenStale: true,
  notificationWindowSec: 8,
  showElapsed: true,
  activityType: 0,
  statusAssets: {
    working:      "https://cdn.qualit.ly/clawd-working-building.gif",
    thinking:     "https://cdn.qualit.ly/clawd-working-typing.gif",
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
        state:   "{currentToolPretty} · {currentFilePretty} · {tokensLabel}",
        largeImageText: "Working on a {fileLang} file",
      },
      thinking: {
        details: "Thinking in {project}",
        state:   "{modelPretty} · {messagesLabel} · {tokensLabel}",
        largeImageText: "Reasoning with {modelPretty}",
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
          { details: "Hotspot · {topEditedFile}",              state: "{topEditedCountLabel} all-time",              requires: ["topEditedCount"] },
          { details: "{allHours} on Claude all-time",          state: "{allSessionsLabel} · {allMessagesFmt} prompts", requires: ["allSessions"] },
          { details: "Lifetime · {allTokensFmt} tokens",       state: "{allToolsFmt} tool calls · {allFilesFmt} files", requires: ["allTools"] },
          { details: "Code churn · {linesAddedFmt} added",     state: "{linesNetFmt} net · {topLanguage}",            requires: ["topLanguage"] },
          { details: "Cost · {todayCostFmt} today",            state: "{allCostFmt} all-time",                        requires: ["allCost"] },
        ],
      },
    },

    buttons: [
      { label: "Claude Code", url: "https://claude.com/claude-code" },
    ],
  },
  statusIcons: {
    working:      "working",
    thinking:     "thinking",
    idle:         "idle",
    notification: "",
    stale:        "",
  },
};
