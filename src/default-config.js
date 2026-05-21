// Inlined default config used to seed %APPDATA%\claude-rpc\config.json on
// first install. Kept in sync with config.example.json. Inlining (rather
// than bundling the JSON as an asset) keeps the build pipeline simple and
// works with both pkg and Node SEA without asset APIs.

export const DEFAULT_CONFIG = {
  clientId: "1506443909406920948",
  appName: "Claude Code",
  updateIntervalMs: 4000,
  rotationIntervalMs: 12000,
  rescanIntervalSec: 300,
  idleThresholdSec: 60,
  // Time (minutes) of no hook activity AND no live transcripts on disk before
  // the daemon treats Claude Code as "not running". Kept short on purpose:
  // when Claude isn't open, the Discord presence should disappear quickly,
  // not linger as "idle" all day. Bump this if you want a longer grace
  // period (the previous default was 720 = 12h).
  staleSessionMin: 5,
  // When true, the daemon CLEARS Discord activity entirely once the state
  // goes stale — your profile shows nothing instead of an "Away" frame.
  // Set false to keep showing the stale frame (old behavior).
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
    largeImageText: "{modelPretty} · {allHours} on Claude · {daysSinceFirstLabel}",
    smallImageKey: "{statusIcon}",
    smallImageText: "{statusVerbose}",
    rotation: [
      { details: "{statusVerbose} in {project}",              state: "{modelPretty}" },
      { details: "{currentToolPretty} · {currentFilePretty}", state: "{modelPretty} · {tokensFmt} tokens",         requires: ["currentFile"] },
      { details: "{statusVerbose} in {project}",              state: "{messagesLabel} · {toolsLabel}",             requires: ["messages"] },
      { details: "{projectSessionLabel} in {project}",        state: "{projectHours} · {projectPromptsLabel}",     requires: ["projectActiveMs"] },
      { details: "Editing in {project}",                      state: "{filesEditedLabel} · {tokensFmt} tokens",    requires: ["filesEdited"] },
      { details: "{concurrentLabel}",                         state: "{concurrentListPretty}",                     requires: ["concurrentOther"] },
      { details: "Today · {todayHours}",                      state: "{todayPromptsLabel} · {todayTokensFmt} tokens", requires: ["todayActiveMs"] },
      { details: "This week · {weekHours}",                   state: "{weekPromptsLabel} · {weekTokensFmt} tokens", requires: ["weekActiveMs"] },
      { details: "{streakLabel}",                             state: "{daysSinceFirstLabel} · {allSessionsLabel}", requires: ["streakIsMilestone"] },
      { details: "{daysSinceFirstLabel} on Claude",           state: "{streakLabel} · {allSessionsLabel}",         requires: ["daysSinceFirst"] },
      { details: "Most active at {peakHour}",                 state: "{peakHourActiveLabel}",                      requires: ["peakHourHours"] },
      { details: "Hotspot · {topEditedFile}",                 state: "{topEditedCountLabel} all-time",             requires: ["topEditedCount"] },
      { details: "{allHours} on Claude all-time",             state: "{allSessionsLabel} · {allMessagesFmt} prompts", requires: ["allSessions"] },
      { details: "Lifetime · {allTokensFmt} tokens",          state: "{allToolsFmt} tool calls · {allFilesFmt} files", requires: ["allTools"] },
    ],
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
