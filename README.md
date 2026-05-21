<div align="center">

<img src="https://cdn.qualit.ly/clawd-working-building.gif" width="120" alt="working" />
<img src="https://cdn.qualit.ly/clawd-working-typing.gif" width="120" alt="thinking" />
<img src="https://cdn.qualit.ly/clawd-notification.gif" width="120" alt="notification" />
<img src="https://cdn.qualit.ly/clawd-sleeping.gif" width="120" alt="idle" />

# claude-rpc

**Discord Rich Presence for [Claude Code](https://claude.com/claude-code).**
Your model, project, current tool, tokens, and lifetime stats — live in your Discord profile.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-43853d.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-hooks-d97757.svg)](https://claude.com/claude-code)
[![Discord RPC](https://img.shields.io/badge/Discord-RPC-5865F2.svg?logo=discord&logoColor=white)](https://discord.com/developers/docs/topics/rpc)

</div>

---

<div align="center">
  <img src="docs/demo.gif" width="560" alt="Discord Rich Presence card: Claude Code, working in claude-rpc on Opus 4.7" />
</div>

Driven entirely by Claude Code's hook system. Zero polling, zero overhead between sessions.

## Features

| | |
| :--- | :--- |
| 🔴 **Live status** | Discord shows model, project, current tool/file, and token counts as you work |
| 🎞️ **Status art** | Large image swaps between *working*, *thinking*, *idle*, *stale*, *notification* |
| 🔁 **Rotation frames** | Cycle through today's stats, streak, top file, lifetime totals, anything you template |
| 🐙 **Auto GitHub button** | When your cwd is a git repo with a github origin, a *View on GitHub* button appears |
| 📊 **All-time aggregates** | Incremental scanner over `~/.claude/projects/*.jsonl` for hours, prompts, tokens, streaks, hotspots, **lines changed, languages, cost, bash usage, web domains, subagent runs** |
| 💰 **Cost estimate** | Per-model spend (Opus/Sonnet/Haiku) using public list prices — editable in `src/pricing.js` |
| 🧠 **Insights** | `claude-rpc insights` (and the web dashboard) generate 3–5 contextual lines: weekly trend, peak weekday, hotspot file, cost pace, streak progress |
| 🖥️ **CLI dashboard** | `claude-rpc status` prints heatmap, hour histogram, top tools / files / projects / languages / bash commands / cost |
| 🌐 **Web dashboard** | `claude-rpc serve` — range selector (7d / 30d / 90d / 1y / All), live SSE updates, project drilldown drawer, day-detail modal, achievements, theme toggle, keyboard shortcuts |
| 🪪 **README badges** | `claude-rpc badge --metric hours --range 7d --out h.svg` (or live at `/api/badge.svg?metric=…`) |
| ⚙️ **Config GUI** | Electron app in `dashboard/` — full settings cockpit across tabs: Presence (drag-reorder, variable autocomplete, presets), Discord (clientId, app name, buttons, activity type), Assets (image preview), Timing, Daemon (start/stop/restart, tail log), Stats (embedded web dashboard) |

## Install

```sh
git clone https://github.com/rar-file/claude-rpc.git
cd claude-rpc
npm install
cp config.example.json config.json
```

Requires Node 18+, the Discord **desktop** client (RPC IPC is unavailable in the browser client), and Claude Code with hook support.

## Quick start

```sh
node ./src/cli.js setup      # register hooks into ~/.claude/settings.json
node ./src/cli.js start      # launch the daemon (detached)
node ./src/cli.js status     # CLI dashboard
node ./src/cli.js serve      # web dashboard at http://127.0.0.1:47474
```

Open Claude Code in any project. Hooks fire on `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, and `SessionEnd`, and the daemon pushes updated presence to Discord within a second.

If you `npm link` (or install the packaged exe), every command above becomes `claude-rpc <command>`.

## Discord app setup

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application named something like `Claude Code`.
2. Copy the **Application ID** into `config.json` under `clientId`.
3. *(Optional)* Under **Rich Presence → Art Assets**, upload images named `claude`, `working`, `thinking`, `idle`, `notification` to match the keys in `statusAssets`.
4. Or skip uploading and use direct URLs in `statusAssets` (e.g. `"https://example.com/working.gif"`). Modern Discord clients fetch them through their media proxy.

## Commands

| Command       | Description                                              |
| ------------- | -------------------------------------------------------- |
| `setup`       | Install hooks into `~/.claude/settings.json`             |
| `uninstall`   | Remove hooks                                             |
| `start`       | Start the daemon (detached)                              |
| `stop`        | Stop the daemon                                          |
| `restart`     | Stop then start                                          |
| `status`      | Current session + all-time dashboard                     |
| `today`       | Today's stats + 24h histogram                            |
| `week`        | This week's stats + daily breakdown                      |
| `serve`       | Open the local web dashboard (port 47474)                |
| `preview`     | Show how each rotation frame renders right now           |
| `scan`        | Incrementally rescan `~/.claude/projects` for aggregates |
| `rescan`      | Force re-parse every transcript                          |
| `insights`    | Print 3–5 auto-generated insight lines                   |
| `badge`       | Render a Shields-style SVG (`--metric hours\|streak\|cost\|lines`, `--range 7d\|30d\|all`, `--out file.svg`) |
| `tail`        | Tail the daemon log                                      |
| `daemon`      | Run the daemon in the foreground (for debugging)         |

## Config GUI

```sh
cd dashboard
npm install
npm start                # dev mode
npm run build            # → dist/claude-rpc-dashboard.exe (Windows portable)
```

The Electron app reads and writes `config.json` directly. The daemon hot-reloads.

## How it works

Three cooperating pieces, glued by JSON files on disk.

```
   Claude Code                                          Discord desktop
        │                                                     ▲
        │ lifecycle event (stdin JSON)                        │ IPC frame
        ▼                                                     │
   ┌──────────┐    state.json    ┌──────────┐                 │
   │ hook.js  │ ───────────────▶ │ daemon.js│ ────────────────┘
   └──────────┘                  └──────────┘
                                       ▲
                                       │ aggregate.json
                                       │
                                ┌────────────┐
                                │ scanner.js │ ◀── ~/.claude/projects/*.jsonl
                                └────────────┘
```

1. **Hook** (`src/hook.js`) — Claude Code spawns it on every lifecycle event. Parses the event JSON from stdin and mutates the shared state file.
2. **Daemon** (`src/daemon.js`) — Long-running. Connects to Discord's local IPC, watches the state file plus periodic transcript scans, pushes presence frames every few seconds.
3. **Scanner** (`src/scanner.js`) — Walks `~/.claude/projects/**/*.jsonl` transcripts for all-time aggregates (active time, prompts, tool calls, tokens, streaks, hour-of-day, top files / projects). Cached at `~/.claude-rpc/aggregate.json` for incremental updates.

Persistent state lives in a few well-known places:

| Path | What |
| ---- | ---- |
| `$TMPDIR/claude-rpc/state.json` | Current session, volatile |
| `~/.claude-rpc/aggregate.json` | All-time aggregates |
| `~/.claude-rpc/scan-cache.json` | Per-transcript scan cache |
| `~/.claude/settings.json` | Hook registrations (managed by `setup`) |

<details>
<summary><b>Configuration reference</b></summary>

`config.json` keys, all optional unless noted:

| Key                       | Default | Notes                                                               |
| ------------------------- | ------- | ------------------------------------------------------------------- |
| `clientId`                | —       | **Required.** Discord application ID                                |
| `updateIntervalMs`        | `4000`  | How often the daemon pushes to Discord                              |
| `rotationIntervalMs`      | `12000` | How fast rotation frames cycle                                      |
| `rescanIntervalSec`       | `300`   | How often transcripts are re-aggregated                             |
| `idleThresholdSec`        | `60`    | No activity for this long → status `idle`                           |
| `staleSessionMin`         | `720`   | No activity for this long → status `stale`                          |
| `notificationWindowSec`   | `8`     | How long the `notification` status sticks                           |
| `showElapsed`             | `true`  | Include the elapsed timer                                           |
| `activityType`            | `0`     | `0` Playing, `2` Listening, `3` Watching, `5` Competing             |
| `statusAssets`            | `{}`    | Image per status (working / thinking / idle / stale / notification) |
| `presence.largeImageKey`  | —       | Fallback large image when no `statusAssets` match                   |
| `presence.largeImageText` | —       | Tooltip on hover                                                    |
| `presence.smallImageKey`  | —       | Small badge in the corner of the large image                        |
| `presence.smallImageText` | —       | Tooltip on hover                                                    |
| `presence.rotation`       | `[]`    | Array of frames, each `{ details, state, requires? }`               |
| `presence.buttons`        | `[]`    | Up to 2 `{ label, url }` buttons                                    |
| `statusIcons`             | `{}`    | Small image key per status (empty string hides it)                  |

### Rotation frames

```jsonc
{
  "presence": {
    "rotation": [
      { "details": "{statusVerbose} in {project}",   "state": "{modelPretty}" },
      { "details": "{currentToolPretty} · {currentFilePretty}",
        "state":   "{tokensFmt} tokens",
        "requires": ["currentFile"] },
      { "details": "Today · {todayHours}",
        "state":   "{todayPromptsLabel}",
        "requires": ["todayActiveMs"] }
    ]
  }
}
```

Each frame has:

- `details` — bold first line (Discord max 128 chars)
- `state` — lighter second line (Discord max 128 chars)
- `requires` *(optional)* — a variable name or array of names. The frame is skipped if any required variable is empty / `0`. Lets you have context-dependent frames (e.g. only show the *current tool* frame when there's actually a tool running).

</details>

<details>
<summary><b>Template variables</b></summary>

Both `details` and `state` (and button labels and URLs) support `{name}` substitution.

| Variable                | Sample             |
| ----------------------- | ------------------ |
| `{statusVerbose}`       | `Working`          |
| `{project}`             | `claude-rpc`       |
| `{modelPretty}`         | `Opus 4.7`         |
| `{currentToolPretty}`   | `Edit`             |
| `{currentFilePretty}`   | `src/app/page.tsx` |
| `{tokensFmt}`           | `2.3k`             |
| `{messagesLabel}`       | `8 prompts`        |
| `{projectSessionLabel}` | `Session #1`       |
| `{projectHours}`        | `22m`              |
| `{todayHours}`          | `56m`              |
| `{weekHours}`           | `3.1h`             |
| `{streakLabel}`         | `7-day streak`     |
| `{daysSinceFirstLabel}` | `Day 31`           |
| `{allHours}`            | `52h`              |
| `{allTokensFmt}`        | `2.82B`            |
| `{peakHour}`            | `22:00`            |
| `{topEditedFile}`       | `index.html`       |
| `{linesAddedFmt}`       | `24k`              |
| `{todayLinesAddedFmt}`  | `320`              |
| `{linesNetFmt}`         | `+18k`             |
| `{topLanguage}`         | `TypeScript`       |
| `{languagesLabel}`      | `TypeScript · Python · Rust` |
| `{topBashCmdLabel}`     | `git × 820`        |
| `{topDomainLabel}`      | `docs.anthropic.com × 28` |
| `{subagentLabel}`       | `Explore × 18`     |
| `{mcpToolPercentLabel}` | `12% MCP`          |
| `{todayCostFmt}`        | `$1.23`            |
| `{allCostFmt}`          | `$89.42`           |
| `{weekdayLabel}`        | `Thursday`         |
| `{startTimeLabel}`      | `started 09:14`    |

Run `node ./src/cli.js preview` to see every frame rendered with your real data, including which ones would be hidden by their `requires`.

</details>

## Badges

Generate a Shields-style SVG you can drop into a README:

```sh
claude-rpc badge --metric hours  --range 7d --out claude-hours.svg
claude-rpc badge --metric streak              --out claude-streak.svg
claude-rpc badge --metric cost   --range 30d  --out claude-cost.svg
claude-rpc badge --metric lines  --range all  --out claude-lines.svg
```

While the daemon's `serve` command is running, the same data is also available live at:

```
http://127.0.0.1:47474/api/badge.svg?metric=hours&range=7d
```

Cost numbers come from `src/pricing.js`, seeded with **approximate** public list prices for Anthropic models. Edit that file to override — your actual Claude Code subscription bill is unrelated.

## Troubleshooting

**Discord doesn't pick up presence.** The Discord *desktop* app must be running. The browser client doesn't expose the local IPC bridge. Verify `clientId` matches your Discord application, and run `claude-rpc tail` to watch the daemon log live.

**Hooks don't fire.** Run `claude-rpc setup` and check the `hooks` section of `~/.claude/settings.json`. Restart Claude Code afterwards so it re-reads the hook config.

**Elapsed timer resets on rotation.** Update to the current version. Older builds passed timestamps in seconds; Discord expects milliseconds.

## License

[MIT](LICENSE) © Archer Simmons
