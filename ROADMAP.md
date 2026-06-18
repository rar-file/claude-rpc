# roadmap

Where claude-rpc is, where it's going, and what it will deliberately never do. This is direction, not a promise — it's a solo project, and the ordering below changes the moment real usage says it should. No dates on purpose.

If something here matters to you (or something missing does), [open an issue](https://github.com/rar-file/claude-rpc/issues) — that's the input that reorders this file.

## where it is — toward 1.0

The build-out phase is done; the surface area is stable enough to commit to it (see [`VERSIONING.md`](VERSIONING.md)). What exists today:

- **Presence pipeline** — hook → state file → daemon → Discord IPC, with reconnect backoff, liveness deadlines, and idle/stale detection grounded in transcript mtimes. A directory watcher plus an mtime-poll fallback so changes are never missed (see [Platform support](README.md#platform-support)).
- **Stats** — incremental scanner over every Claude Code transcript; web dashboard (`serve`, SSE-live) + terminal TUI; SVG cards/badges/posters/calendar; year-in-review (`wrapped`); subscription-usage readout (`usage`, the same numbers `/usage` shows).
- **Web layer** — a Cloudflare Worker holding anonymous global totals (opt-out) and an opt-in leaderboard with GitHub-verified profiles, squads (private weekly mini-boards), and machine linking. Live per-user **badge and card image endpoints** (`/badge/<handle>.svg`, `/card/<handle>.svg`) render straight into a README — no `gh`, no gist, paste once. Full HTTP reference in [`docs/WORKER-API.md`](docs/WORKER-API.md).
- **Integrations** — a [Claude Code plugin](plugin/) (a thin `SessionStart` bootstrapper, zero model-context cost) and an [MCP server](src/mcp.js) (`claude-rpc mcp`) that exposes your own stats as tools you can ask Claude about mid-session.
- **Trust posture** — zero runtime dependencies, CI Actions pinned to SHAs, npm provenance on every release, a [`SECURITY.md`](SECURITY.md) that documents every sensitive behavior, and a security pass over the dashboard, local server, and worker.
- **Onboarding** — `setup` test-fires a real hook end-to-end, `doctor` diagnoses every known failure mode, `profile status` shows the whole checklist in one place.

## next

The honest answer: **listen.** The build-out was self-directed polish; the next version should be shaped by people actually using it. Bug reports and feature requests from real installs outrank everything below.

With that caveat, the likely candidates:

- **More install paths.** npm, the Homebrew tap, and standalone binaries exist; AUR and a `.deb` are the obvious gaps, `winget`/`scoop` after that.
- **Windows reliability.** The daemon already runs an mtime-poll fallback because `fs.watch` is unreliable there; Windows deserves the same first-class confidence as macOS/Linux, not a fallback.
- **Presence customization in the dashboard.** The rotation frames and 200+ template variables are fully configurable in `config.json`, but the Electron dashboard only edits a subset. A frame editor with live preview would make the most powerful feature discoverable.
- **Smarter idle story.** Idle detection works, but the away/back transitions could be richer — per-frame idle variants, configurable grace periods.

## later / maybe

Ideas that have come up and survived, but don't justify the complexity yet:

- Richer year-in-review (more slides, comparisons across years once there *are* multiple years of data).
- Per-project presence profiles — different frames/assets per repo, beyond the current privacy toggles.
- Localized number/date formatting in cards and dashboards.

## never

These are design decisions, not backlog. Issues asking for them will be closed with a link here.

- **No runtime dependencies.** Zero stays zero. The Discord IPC client is ~200 lines we own; that beats ten transitive packages every time.
- **No database, no message bus.** Three processes glued by JSON files on disk is the architecture, not a placeholder for one.
- **No frameworks in the dashboard.** The web dashboard is vanilla CSS/HTML/JS inlined as strings so it works offline inside the single-file exe. React/Vue/bundlers don't fit that constraint.
- **No telemetry beyond what's documented.** The anonymous community total is the entire payload, it's documented byte-for-byte in [`SECURITY.md`](SECURITY.md), and `claude-rpc community off` ends it. Nothing else phones home, ever.
- **No install scripts.** `npm install` runs nothing. That's load-bearing for supply-chain trust and it stays that way.
