<div align="center">

<img src="https://cdn.qualit.ly/clawd-working-building.gif" width="120" alt="working" />
<img src="https://cdn.qualit.ly/clawd-working-typing.gif" width="120" alt="thinking" />
<img src="https://cdn.qualit.ly/clawd-notification.gif" width="120" alt="notification" />
<img src="https://cdn.qualit.ly/clawd-sleeping.gif" width="120" alt="idle" />

# claude-rpc

**Discord Rich Presence for [Claude Code](https://claude.com/claude-code).**
Your live model, project, current tool, tokens, and lifetime stats — in your Discord profile. Driven by the hooks Claude Code already fires. Zero polling between sessions.

[![community · sessions](https://claude-rpc-totals.claude-rpc.workers.dev/sessions.svg)](#community-totals-opt-in) &nbsp; [![community · tokens](https://claude-rpc-totals.claude-rpc.workers.dev/tokens.svg)](#community-totals-opt-in)

<sub>live, opt-in — see [community totals](#community-totals-opt-in)</sub>

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 18+](https://img.shields.io/badge/node-%3E%3D18-43853d.svg?logo=node.js&logoColor=white)](https://nodejs.org)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-hooks-d97757.svg)](https://claude.com/claude-code)
[![Discord RPC](https://img.shields.io/badge/Discord-RPC-5865F2.svg?logo=discord&logoColor=white)](https://discord.com/developers/docs/topics/rpc)
[![Release](https://img.shields.io/github/v/release/rar-file/claude-rpc?color=4c1)](https://github.com/rar-file/claude-rpc/releases/latest)

</div>

---

<div align="center">
  <img src="docs/demo.gif" width="560" alt="Discord Rich Presence card showing Claude Code working in claude-rpc on Opus 4.7" />
</div>

A small Node daemon that takes the lifecycle events Claude Code already fires and pipes them into the Discord rich-presence card on your profile. Your friends see what you're building; your future self gets lifetime stats. Built solo, on weekends.

## install

**Windows (no Node required)** — [grab the portable exe from the latest release](https://github.com/rar-file/claude-rpc/releases/latest):

```sh
claude-rpc setup
claude-rpc start
```

That's the whole pitch. Open Claude Code in any project — the daemon picks it up within a second. Something looks wrong? `claude-rpc doctor`.

The Discord *desktop* app must be running. The browser client doesn't expose the local IPC bridge that Rich Presence uses.

<details>
<summary><b>other platforms / from source</b></summary>

```sh
git clone https://github.com/rar-file/claude-rpc.git
cd claude-rpc
npm install
node ./src/cli.js setup
node ./src/cli.js start
```

Or `npm install -g claude-rpc` for the global bin. Both modes survive `npm update` without losing your `clientId` — user config lives under the per-OS config dir, not inside `node_modules`.
</details>

<details>
<summary><b>use your own Discord app</b></summary>

A working public Discord application is bundled into the default config — you don't need to register your own to get started. If you want a different app name on the card, create one in the [Discord Developer Portal](https://discord.com/developers/applications), copy the Application ID, and drop it into your config:

```sh
# Linux
echo '{ "clientId": "YOUR_ID" }' > ~/.config/claude-rpc/config.json
# macOS
echo '{ "clientId": "YOUR_ID" }' > ~/Library/Application\ Support/claude-rpc/config.json
# Windows (PowerShell)
'{ "clientId": "YOUR_ID" }' | Set-Content $env:APPDATA\claude-rpc\config.json
```

`claude-rpc upgrade-config` if you're carrying forward a v0.3-era file.
</details>

## what claude-rpc does

### on discord

A card that updates as you work. The large image swaps between five states (working / thinking / idle / stale / notification — those gifs at the top of this README). The two lines of text rotate through frames you template — current file, today's hours, lifetime totals, top hotspot, code churn, cost — and the daemon skips frames whose required template variables are empty. The `SessionEnd` hook clears the card instantly when you close Claude Code; no "is it still running?" timeout.

A *View on GitHub →* button appears automatically when your cwd is a git repo with a github origin. The daemon checks `.git/config` directly — no shell-out, no surprise GH API call.

### on your machine

Three local surfaces, all reading the same `~/.claude-rpc/aggregate.json`:

<table>
<tr>
<td align="center" width="50%"><b>web dashboard</b><br/><sub><code>claude-rpc serve</code> · port 47474</sub><br/><br/><img src="docs/dashboard.png" alt="Web dashboard with range selector, activity chart, heatmap, cost panel, languages stack, and leaderboards" /></td>
<td align="center" width="50%"><b>settings gui</b><br/><sub><code>npm run dashboard</code> · Electron</sub><br/><br/><img src="docs/electron.png" alt="Electron config editor with Presence / Discord / Assets / Timing / Daemon / Stats tabs" /></td>
</tr>
</table>

```text
claude-rpc status                 (TUI — heatmap, hour histogram, leaderboards)
claude-rpc today                  (today's stats, focused)
claude-rpc week                   (weekday breakdown)
claude-rpc preview                (every rotation frame rendered with real data)
claude-rpc insights               (3–5 auto-generated lines: trend, peak, hotspot)
```

The web dashboard pushes updates via SSE; the TUI refreshes on a 3-second tick.

### beyond your machine

Shields-style badges and a poster-style summary card you can paste into a README or a Discord message:

```sh
claude-rpc badge --metric hours  --range 7d   --out claude-hours.svg
claude-rpc badge --metric streak              --out claude-streak.svg
claude-rpc badge --metric hours  --gist                                     # publish to a gist (live README badge)
claude-rpc card  --range year                 --out year-on-claude.svg
```

<div align="center">
  <img src="site/examples/year-on-claude.svg" width="560" alt="Year-on-claude card — hours, prompts, tokens, lines, cost, daily activity strip" />
</div>

`badge --gist` writes the SVG to your own GitHub gist (creates one on first run, updates it after — id remembered in `config.json`). The URL printed back is README-ready and updates every time you re-run the command. Uses `gh` if available, else `GH_TOKEN` with `gist` scope.

Live equivalents when the daemon is up:

- `http://127.0.0.1:47474/api/badge.svg?metric=hours&range=7d`
- `http://127.0.0.1:47474/api/card.svg?range=year`

Cost numbers come from `src/pricing.js`, seeded with **approximate** public list prices. Your actual Claude Code subscription bill is unrelated.

### community totals (opt-in)

The badges at the top of this README are live, served by a small Cloudflare Worker ([`worker/`](worker/)) that holds running totals of sessions and tokens across every install that has opted in. The opt-in is per-install and **off by default**:

```sh
claude-rpc community              # show state
claude-rpc community on           # opt in (consent flow + prints exact payload)
claude-rpc community off          # opt out
claude-rpc community report       # one-shot manual flush (testing)
```

Each report sends only: a `sessionsDelta`, a `tokensDelta`, the claude-rpc version, OS family (`linux`/`darwin`/`win32`), and an anonymous UUID v4. No prompts, paths, models, repos, costs, usernames, or hostnames — the Worker's [`validateReport`](worker/src/index.js) is the schema of record. The full Worker source is in this repo so the privacy claim is auditable.

## three pieces, glued by json files

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

No database, no message bus, no background polling when Claude Code isn't running. State on disk you can `cat` and `jq`. The single runtime dependency is `@xhayper/discord-rpc`.

1. **hook** ([`src/hook.js`](src/hook.js)) — Claude Code spawns it on every lifecycle event. Parses the JSON from stdin and mutates the shared state file. Runs in ~20ms.
2. **daemon** ([`src/daemon.js`](src/daemon.js)) — long-running. Connects to Discord's local IPC, watches the state file, pushes presence frames every few seconds. Exponential backoff with jitter on reconnect; `daemon.log` rotates at 5 MB.
3. **scanner** ([`src/scanner.js`](src/scanner.js)) — walks `~/.claude/projects/**/*.jsonl` for all-time aggregates (active time, prompts, tools, tokens, streaks, hotspots, lines, languages, cost, bash, web, subagents). Incremental — re-parses only changed files.

Persistent state, all human-readable JSON:

| Path | What |
| ---- | ---- |
| `$TMPDIR/claude-rpc/state.json` | Current session, volatile |
| `~/.claude-rpc/aggregate.json` | All-time aggregates |
| `~/.claude-rpc/scan-cache.json` | Per-transcript scan cache |
| `~/.claude-rpc/private-list.json` | Runtime privacy toggles |
| `~/.claude/settings.json` | Hook registrations (managed by `setup`) |

User config lives at `%APPDATA%\claude-rpc\config.json` (Windows), `~/Library/Application Support/claude-rpc/config.json` (macOS), or `$XDG_CONFIG_HOME/claude-rpc/config.json` (Linux). It only needs to hold *overrides* — every key has a baked default. `{ "clientId": "..." }` is a complete config file. Defaults live in [`src/default-config.js`](src/default-config.js); the loader deep-merges over them.

## privacy

Per-project, runtime, or auto-detected — whichever fits how you work.

```jsonc
// drop at your project root: <project>/.claude-rpc.json
{ "private": true }                                  // shortcut for visibility: "hidden"
{ "visibility": "name-only" }                        // project name only, no file/tool detail
{ "projectName": "redacted" }                        // show this name on Discord instead
```

Or from the command line, in any project:

```sh
claude-rpc private        # add cwd to ~/.claude-rpc/private-list.json
claude-rpc public         # remove cwd
claude-rpc privacy        # show the resolved visibility for the current dir
```

Or globally, in `config.json`:

```json
{ "privacy": { "patterns": ["client-*", "secret-stuff"], "mode": "hidden" } }
```

If [`gh`](https://cli.github.com/) is installed and authenticated, GitHub-private repos auto-hide (`privacy.githubPrivateMode`, default `hidden` — opt out with `privacy.autoDetectGithubPrivate: false`). 5-minute cache, 1.5s timeout, silent skip when `gh` isn't there.

Aggregates and local dashboards are never affected. Privacy is a one-way valve between local state and Discord.

## customizing the card

```sh
claude-rpc preview        # render every rotation frame with your real data
claude-rpc vars           # dump the full template-variable list as JSON
```

Frames have a `requires` field; the daemon skips a frame when any of its required vars resolve empty / zero. Write seven frames knowing only the relevant ones render.

```jsonc
"idle": {
  "details": "Idle in {project}",
  "state":   "{modelPretty} · {todayHours} today",
  "rotation": [
    { "details": "This week · {weekHours}",      "state": "{weekPromptsLabel} · {weekTokensFmt} tokens",
      "requires": ["weekActiveMs"] },
    { "details": "Code churn · {linesAddedFmt} added",
      "state":   "{linesNetFmt} net · {topLanguage}",
      "requires": ["topLanguage"] }
  ]
}
```

The full default config is in [`src/default-config.js`](src/default-config.js) — that's the canonical list of every key. ~140 template variables are available; `claude-rpc vars` is the source of truth.

## commands

| Command          | What it does |
| ---------------- | ------------ |
| `setup`          | Install Claude Code hooks (test-fires one synthetic SessionStart to prove the pipe works) |
| `uninstall`      | Remove Claude Code hooks |
| `upgrade-config` | Re-run idempotent migrations on `config.json` |
| `start` / `stop` / `restart` | Lifecycle for the detached daemon |
| `status`         | Interactive TUI — heatmap, hour histogram, leaderboards (`--dump` for plain output) |
| `today` / `week` | Focused views (today's stats, weekday breakdown) |
| `serve`          | Open the local web dashboard (port 47474) |
| `preview`        | Render every rotation frame against real state |
| `scan` / `rescan`| Incremental / forced re-parse of `~/.claude/projects` |
| `backfill <dir>` | Import transcripts from any folder (backup, other machine) |
| `insights`       | Print 3–5 auto-generated lines about your week |
| `badge`          | Shields-style SVG (`--metric` `--range` `--out` `--gist`) |
| `card`           | Poster-style SVG (`--range year\|month\|week\|all`) |
| `private` / `public` / `privacy` | Per-cwd visibility toggles + status |
| `community`      | Opt-in community totals — `on` \| `off` \| `status` \| `report` |
| `doctor`         | Diagnostic checklist with one-line fix hints |
| `tail` / `logs`  | Tail the daemon log |
| `daemon`         | Run the daemon in the foreground (debugging) |
| `vars`           | Dump the full template-var list as JSON |

Exit codes: `0` ok · `1` user error · `2` system error · `3` wrong state. `--version` and `--help` work as expected.

## troubleshooting

**First step is always `claude-rpc doctor`.** It checks Node version, hook registration, daemon liveness, Discord IPC connection, aggregate freshness, and privacy resolution — with a one-line fix hint per failure.

- **Discord doesn't show anything.** Discord *desktop* must be running. The browser client doesn't expose the local IPC bridge. `claude-rpc tail` shows what the daemon is actually doing.
- **Hooks don't fire.** `claude-rpc setup` re-registers them and now test-fires a synthetic `SessionStart` end-to-end, so a broken hook command surfaces immediately. Restart Claude Code afterwards so it re-reads its hook config.
- **Config error.** Bad JSON in `config.json` no longer crashes anything — the daemon logs one line and falls back to baked defaults. `claude-rpc tail` shows the parse error verbatim.
- **Old binary path baked into hooks.** Common after manual exe replacement. `claude-rpc setup` rewrites hook entries to point at the canonical install location.

## development

```sh
npm test                  # 200+ tests, ~1.7s
npm run start             # run daemon in foreground
npm run serve             # web dashboard against your real data
npm run dashboard         # Electron settings GUI (dev mode)
npm run build:exe         # SEA single-file binary for the current OS
```

Tests are `node --test` with zero deps. The CI pipeline ([release.yml](.github/workflows/release.yml)) gates the matrix build and the npm publish behind the test job. Every public export of `src/*.js` is exercised at least once.

## license

[MIT](LICENSE) © Archer Simmons
