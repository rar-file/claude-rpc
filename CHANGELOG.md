# Changelog

All notable changes to claude-rpc. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.20.4] - 2026-06-15

**Changed**

- **The interactive `claude-rpc status` dashboard is a full redesign.** It went from a thin column pinned to the top-left into a full-screen, two-column framed dashboard on the alternate screen buffer (your terminal is restored on quit), centered and size-capped so it reads as a tidy panel on a large window instead of a strip glued to the edge. The header has room to breathe and the tab bar is centered. NO_COLOR still degrades to box-only, and the static `status --dump` output is unchanged.
- **Week tab now shows a rolling last 7 days** — a daily bar with hours for each of the past seven days, plus a 7-day totals panel including spend — instead of a Mon–Sun calendar grid that was mostly empty `—` early in the week.
- **Cost tab adds per-project spend** — a "by project" table alongside "by model", plus a today / week / month-to-date / forecast strip.

## [0.20.3] - 2026-06-15

**Fixed**

- **Notification counts no longer drop a day when the events log rotates.** `events.jsonl` rotates to `.1` at 5 MB, but the scanner only read the live file — so lifetime notification counts silently lost everything in the rotated half. It now reads both halves (oldest first).
- **Idle frames no longer show stale file/tool names after a notification.** When a `Notification` state expired to idle, the current-tool / current-file / edited-files slots were left populated, so an idle rotation frame could still display the last file you touched. They're now cleared on that transition, matching the normal idle path.
- **Daemon-liveness check no longer misreads a permission error as "not running."** The CLI carried its own `process.kill(pid, 0)` probe whose `catch` treated `EPERM` (process exists but owned by another user) as dead; it now uses the shared `daemonAlive` helper (`EPERM` → alive) — the same one the self-heal and single-instance guard already use.

## [0.20.2] - 2026-06-15

**Fixed**

- **Lifetime stats can no longer be silently corrupted by a rewritten transcript.** The scanner's incremental-append fast-path only checked that a file was at least as large as the last *consumed offset*, so a transcript rewritten to a size between that offset and its previous size was treated as an append onto now-stale counts — quietly carrying dead data into your all-time totals with no recovery short of `rescan`. It now requires the file to be at least as large as it was at the previous parse (the same guard `readSessionTokens` already used) and falls back to a full re-parse otherwise.

**Added**

- **`subagentActiveMs` — delegated active time is tracked on its own.** Subagent runs already contributed their tokens/cost/lines to lifetime totals, but their active time was dropped entirely (a naive sum would double-count, since subagent wall-time overlaps the parent session). The aggregate now exposes subagent active time as its own field, leaving `activeMs` an honest interactive-session measure.

**Performance**

- **Faster CLI startup for the common commands.** `claude-rpc --version` / `--help` / `start` / `stop` / `restart` no longer eagerly load the full stats/format/install module graph they never use (~60ms of imports); it's lazy-loaded only for commands that actually fan out into it.

**Leaderboard service** (deployed separately, not part of the npm package)

- Duplicate-handle repair never drops a contested row — it prefers the verified claim when the `handle:` pointer is unresolvable, instead of dropping every row for the handle. Community deltas must now be whole integers. The per-machine squad index dedups on write, and squad/profile reads fan out concurrently instead of one serial KV get at a time.

## [0.20.1] - 2026-06-15

**Added**

- **Self-healing startup — the daemon comes up whenever you use Claude Code, on every platform.** Until now the daemon started only from `setup`/`start` or, on Windows, a login Run-key entry — macOS/Linux had no autostart at all, and a reboot, crash, or OS sleep on *any* platform left the card silently dark until you manually restarted it (the "startup is iffy" reports). The `SessionStart` hook now self-heals: if no daemon is running when a session begins, it spawns one (detached, windowless, best-effort). Presence is assured exactly when it matters — when you're using Claude — with no 24/7 background daemon required. It's a no-op when a daemon is already up and is cooldown-guarded against spawn storms. Opt out with the new `autostart` config key (default `true`) and manage the daemon yourself.

**Fixed**

- **Two daemons can no longer start at once.** The single-instance guard did a non-atomic read-then-write of the pid file, so two launchers firing in the same instant (a manual `start` racing the new self-heal, or several concurrent sessions' hooks) could both see "no live owner" and both run — two daemons fighting over the card every ~4s and double-counting community totals. It's now an atomic exclusive-create claim (`ensure-daemon.claimSingleInstance`): exactly one daemon wins, the rest detect it and exit, and a stale pid from a crashed daemon is reclaimed.
- **The daemon no longer dies silently on an unexpected error.** It had no `uncaughtException` / `unhandledRejection` handlers, so a stray throw in any path could end hours of uptime with nothing in the log. Both are now caught, logged, and survived — a presence daemon is best-effort and should stay up.
- **`claude-rpc start` tells the truth.** It spawned the daemon detached and printed "launched" even if the process died a millisecond later (bad path, single-instance loss, startup throw), and a spawn `ENOENT` could bubble as an unhandled crash. The spawn recipe is now shared with the hook, spawn errors are caught, and `start` confirms the daemon actually came up (polling the pid file) before reporting success.

## [0.19.2] - 2026-06-15

**Fixed**

- **The card no longer goes blank or sticks on a stale frame during active work — the daemon now respects Discord's activity rate limit.** Discord hard-limits `SET_ACTIVITY` (~5 writes per 20s) and *punishes* a burst: ~10 writes in 5s makes the client **empty the presence and stop updating** until the writes stop ([discord-api-docs#668](https://github.com/discord/discord-api-docs/issues/668)). The Game SDK claims to coalesce for you; we speak **raw IPC** (zero cushion) and were writing on *every* hook-driven state change — so a flurry of quick `Read`/`Edit`/`Bash` tools (each firing `PreToolUse`+`PostToolUse`, flipping `currentTool`/`currentFile`) drove several writes a second, far past the limit. That is the "it sometimes seems a bit buggy" users saw: the card froze, blanked, or lagged behind reality. The daemon now throttles itself with a leading+trailing coalescer — the first change after a quiet gap writes immediately (snappy `idle`→`thinking`→`working`), and changes inside the gap collapse to the **latest** and flush once when it expires, so the final state of every burst always lands at a wire rate that stays under the limit (a pathological 200-changes-in-20s run drops from 200 writes to ~6). Tunable via the new `minActivityGapMs` config key (default `4000`).
- **A dropped or rate-limited presence write is now retried instead of being stranded.** `pushPresence` advanced its payload-dedup hash *before* awaiting the write and only reset it on connection errors — so a write that failed for any other reason (a rate-limit rejection, a transient app error) was recorded as if it had succeeded, and the card stuck on the previous frame until the state next changed. The hash now advances **only after a confirmed write**, so the periodic tick re-sends the current frame on the next pass; this compounded the rate-limit blanking above.

## [0.19.1] - 2026-06-15

**Fixed**

- **Hooks no longer fail with `claude-rpc: command not found` under nvm.** Claude Code runs hooks through `/bin/sh`, whose minimal PATH — under nvm — contains neither `claude-rpc` nor `node` (there's no system node). The wired commands (`claude-rpc hook <event>` for npm installs, bare `node "<hook.js>"` for dev) both depend on PATH, so every Pre/PostToolUse hook errored. `setup` now writes the **absolute** node (`process.execPath`) + absolute `hook.js` for npm and dev installs alike (the packaged exe was already self-contained) — PATH-independent, and it also moots the old Windows PATHEXT/`.cmd` shell workaround in `verifyHookPipe`. Survives `npm update` and nvm version switches; re-run `setup` only if the node version used at setup is later removed.

## [0.19.0] - 2026-06-15

Audit-remainder cleanup pass — the reliability/security tail the v0.17 sweep left behind, plus DRY/test-hardening to slim the surface. One live crash fixed.

**Fixed**

- **Config-mutating commands no longer crash.** `writeUserConfig` (introduced in v0.17.0) called itself instead of writing the file, so `community on/off`, `profile set`, `link`, and the gist/profile config writers stack-overflowed and never persisted. Restored the write and added a subprocess regression test (cli.js has no importable seam, which is why it shipped).
- **`claude-rpc status`, the web dashboard, and the TUI no longer show an empty session mid-work.** Since v0.18.0 hooks write per-session `state-<id>.json` and only the daemon resolved the active one; the inspection surfaces still read the legacy global `state.json` (which per-session hooks never write), so they showed "Standing by / no project / 0 messages" while the Discord card was correct. A shared `readActiveState()` now resolves the active session for all of them. *(Found by running the daemon + dashboard against a live session, not by the test suite.)*
- **Live presence works on relocated installs** — `findLiveSessions` now scans the same alternate project dirs (XDG, AppData, Library) the scanner already discovers, not just `~/.claude/projects`.
- **The dashboard connection badge tells the truth** — it follows the EventSource `onopen`/`readyState` (showing `offline` when the daemon is actually down) instead of a blind 4s timer that always flipped back to "live"; the SSE stream now sends a ~20s heartbeat so half-open connections get reaped.
- **discord-ipc** gains a per-candidate connect timeout (a socket that accepts then stalls can't wedge discovery of the real one), and the daemon's `connect()` is guarded so the watchdog can't spawn a competing client mid-login.
- **`detectGithubPrivate` no longer blocks the daemon** — the 1.5s `gh` probe moved off the render path (async, fills the cache for the next tick).
- **The installer won't disturb a third-party hook** — our hook entries are tagged (`_claudeRpc`) and install/uninstall key off the tag, so a foreign `…/hook.js` is never rewritten or deleted; `verifyHookPipe` parses the ack instead of substring-matching `"continue"`.
- **The dashboard heatmap** shows a fixed 90-day window regardless of the range pill and color-normalizes against only the cells it draws (it was blanking on 7d/30d and dimming against off-window peaks).
- **`gh -R owner/repo pr create`** is recognized by the "just shipped" detector (global flags skipped); the concurrent-session list no longer leaks a `$HOME`-named project as the OS username.
- Renderer/usage hardening: out-of-range `peakHour`/weekday are dropped rather than rendering `99:00`/blank labels; a future-dated usage cache reads as stale; the token-expiry check gains a 30s skew margin; the MCP stdio server caps an unterminated line, attaches an `error` listener, and echoes a recognized client `protocolVersion`.
- **`fmtNum`/`fmtHours` tier-boundary rounding** — `999_999` now formats as `1.00M` (not `1000.0k`) and `59.7m` as `1.0h` (not `60m`), consistently everywhere.

**Security**

- **The leaderboard worker** strips bidi/zero-width/C1 characters from display names (shared-board visual spoofing) and, in the no-gistId verify fallback, takes the verified owner from the gist itself, sends no client credentials to the public raw URL, and fetches only from `gist.githubusercontent.com`. *(Ships on the next `wrangler deploy`, together with the v0.17.0 board-impersonation fix, which is not yet live.)*

**Internal**

- `fmtNum`/`fmtHours` consolidated into `src/fmt.js` (six diverging copies → one; the worker keeps a byte-for-byte mirror) and the Monday-week grid into `src/week.js` — both unit-tested. Doctor's clientId classification and daemon-log IPC inference are now pure, tested helpers. `desktopNotify` takes an injectable spawn so `npm test` no longer fires a real OS toast. Removed a stray NUL byte that made `install.js` read as a binary file.

## [0.18.0] - 2026-06-14

**Added**

- **Per-session presence — the card no longer thrashes when several Claude sessions run at once.** Every concurrent session used to write one shared `state.json`, so the card jumped between projects, the elapsed timer reset (it followed whichever session pinged last), message/tool counters summed across sessions, and the "N sessions" count wobbled. Now each session writes its own `state-<sessionId>.json` (from the hook's `session_id`; subagent hooks carry the parent's id, so they roll up), and the daemon shows one session with **stickiness** — it stays on the session you're actively working in and only switches once that one goes idle, then jumps to wherever you're now active. The elapsed timer and the GitHub button follow the shown session (so both stay stable), counters are per-session, the party count is derived from the same per-session list so it stays consistent with the card, and a just-ended session drops out immediately. Single-session behavior is byte-identical, and a hook payload without a session id falls back to the old global state file. Per-session files also remove the cross-session lock contention and are swept once they age out.

## [0.17.2] - 2026-06-14

**Fixed**

- **The usage rotation frame printed the weekly % twice.** v0.17.0 added the weekly percentage to `{usageStateLabel}` (the frame's lower/state line), but that frame's details line already reads `Usage · {usageWeeklyPct}% weekly` — so the card showed weekly twice. The state line now complements the header (session % + reset day) and only falls back to weekly % when the session % is absent.

## [0.17.1] - 2026-06-14

**Fixed**

- **A private repo's GitHub link could appear on the Discord card.** The "View on GitHub →" button URL is read straight from `.git/config` (no tooling required), but auto-hiding a *private* repo relies on the `gh` CLI (`gh repo view --json isPrivate`). On a machine without `gh` installed/authenticated, claude-rpc couldn't tell the repo was private, fell back to treating it as public, and showed the button — leaking the repo. Two changes close the gap: a new **`presence.githubButton: false`** kill switch that suppresses the auto button unconditionally (no `gh` needed), and a **`doctor` warning** ("private-repo guard") that fires when the current directory is a GitHub repo, the button would show, and `gh` can't confirm the repo is public — pointing at `gh auth login`, the new toggle, or `claude-rpc private`. The button-visibility decision moved into `src/presence.js` (`shouldShowGithubButton`) with unit coverage. Workarounds for an affected repo without upgrading: `gh auth login`, `claude-rpc private`, or a `.claude-rpc.json` with `{ "visibility": "name-only" }`.

## [0.17.0] - 2026-06-14

A broad correctness, reliability, and security pass driven by a full-codebase audit — 34 findings fixed across the daemon, hook, scanner, CLI, local server, Cloudflare worker, and docs — plus testability work (the presence-render core and the rotation logic are now unit-tested).

**Added**

- **Existing users finally receive new default rotation frames.** `migrateConfig` now backfills default frames shipped *after* a user's first install — the v0.16 `Usage`, `Cost`, `Code churn`, `Daily goal`, and `Monthly budget` frames — onto any rotation that's still default-derived, leaving customized rotations untouched. Rotation arrays were seeded once and never reconciled (arrays replace on merge), so these frames had only ever reached fresh installs.
- **The dashboard range stat card shows a real "vs prior" delta** (current window vs the preceding identical window) instead of a permanently blank `—`.

**Fixed**

- **Desktop notifications & webhooks no longer fire while paused or `privacy=hidden`** — they were defeating the snooze and the hidden flag.
- **A `SessionEnd` from one session no longer blanks the card while a sibling session is mid-work** — the daemon adopts the live sibling instead. (Single-session close still clears, unchanged.)
- **Single-instance daemon guard** — a second daemon now steps aside when a live one owns the PID file, instead of fighting over `setActivity` and double-counting community totals; `restart` polls for the old daemon to exit rather than guessing with a fixed sleep that could leave *no* daemon running.
- **Hook acks survive a state-write failure** — the documented `{continue:true}` contract is always honored, so a full/unwritable tmpdir can't surface an error in the user's turn.
- **The local dashboard is crash-resistant:** `/api/aggregate?range=<huge>` is clamped (it could spin the event loop ~100M iterations), and a thrown `/api` handler returns 500 instead of crashing the whole `serve` process.
- **Windows reliability:** `gh` is detected for `badge --gist` (was falling through to a token error); the login-startup entry launches windowless via a `.vbs` shim (no persistent console window); `IS_PACKAGED` no longer misfires on a `nodejs`/`node24` binary (which broke `CONFIG_PATH`/hooks on those installs); and a maliciously-named project directory can't inject into the PowerShell notifier.
- **The presence base frame is shown on entering a status** instead of being immediately skipped to a rotation frame.
- Network calls across community / gist / notify / squad now time out; `squad`/`link` failures exit cleanly instead of dumping an undici stack, with a top-level rejection floor for the exit-code contract.
- `MultiEdit` now counts toward churn, hotspots, and language stats; the model-less cost bucket no longer renders a `null` bar; GitHub detection survives a bracketed `git config` comment; the MCP server returns proper JSON-RPC errors for unknown tools and a "run scan" hint when there's no data; `doctor` no longer prints `null%`; CLI flag parsers reject a missing value (`badge --out --gist` no longer writes a file named `--gist`); config-mutating commands work before `setup`; `PreCompact` is wired so the `compacting` state is reachable (and the dead `PostToolUse`/`PostCompact` code is gone); `--help` documents `mcp uninstall` and `status --dump`.

**Security**

- **The public leaderboard worker no longer trusts a client-supplied `githubUser`** — only the verify/link flow can set it, blocking board impersonation; verified-only emission also sanitizes legacy rows. *(Ships on the next `wrangler deploy`.)*
- **`SECURITY.md` is byte-accurate again:** documents the status webhook (a sixth network destination) with its exact payload, the recurring `/profile` flush, and the desktop dashboard's auto-update; the subprocess inventory now lists every spawnable binary (`npm`, `claude`, `security`, `osascript`/`powershell`/`notify-send`, `wscript`, `chcp`).

**Internal**

- The presence-render core (`pickFrames` / `selectFrame` / `resolveLargeImageKey`) is extracted into a side-effect-free `src/presence.js` and unit-tested — it previously lived inside `daemon.js`, which can't be imported under test. Dead code removed; orphaned per-pid `state.json.<pid>.tmp` files are swept on daemon startup.

## [0.16.2] - 2026-06-14

**Fixed**

- **Windows: file-watch events the OS drops now recover in ~3s instead of 30s, and `pause`/`config` changes can no longer get stranded.** The daemon reacts to its four on-disk inputs — `state.json`, `pause.json`, `config.json`, `aggregate.json` — with a directory watcher *and* an mtime-poll fallback, because `fs.watch` drops events on Windows when the writer commits via atomic rename (which all four writers do). Two gaps closed: the fallback only ever polled `state.json` and `aggregate.json`, so a missed `pause.json` or `config.json` event had **no** backstop and could hang until the next unrelated change (a `claude-rpc pause` that never cleared the card, an edited config the daemon never reloaded); and the single 30s interval left Windows — where the watcher is the *unreliable* party — with a 30s worst-case lag instead of the sub-second latency macOS/Linux get from inotify/FSEvents. The poll now covers all four inputs and runs every 3s on Windows (still a lazy 30s elsewhere, where it's pure belt-and-suspenders). The watcher and poll now share one last-seen-mtime baseline, so the poll fires — and logs — only for events the watcher genuinely missed, rather than re-handling and re-pushing every change it already caught. Decision logic lives in `src/watch-poll.js` with unit coverage.

## [0.16.1] - 2026-06-12

**Fixed**

- **`claude-rpc preview` previews the frames the daemon actually renders.** It still read only the legacy top-level `presence.rotation` — dead config for anyone on the v0.3.6+ `byStatus` shape — so new frames (like the v0.16.0 usage frame) were invisible in preview while rendering fine on Discord. Preview now walks `byStatus` (base frame + rotation, grouped per status, current status marked) and falls back to the legacy rotation only for old configs.

## [0.16.0] - 2026-06-12

**Added**

- **Subscription usage on the card — "Usage · 34% weekly".** claude-rpc now surfaces the exact numbers Claude Code's own `/usage` screen shows (5-hour session %, weekly %, per-model weekly buckets). The daemon reads the OAuth token Claude Code already stores locally and polls Anthropic's own usage endpoint every 10 minutes while a session is live; the token is sent **only to its issuer**, never logged or forwarded, and the refresh token is never touched (`SECURITY.md` §3d documents the exact request). New pieces: a default rotation frame (`Usage · {usageWeeklyPct}% weekly` — vanishes whenever data is missing or stale), template vars `{usageSessionPct}` `{usageWeeklyPct}` `{usageStateLabel}` `{usageWeeklyResets}` `{usagePlan}` and friends, a `claude-rpc usage` command with heat-graded bars (works without the daemon — falls back to a one-shot live fetch), a `claude usage` box in `status`, and a `doctor` row. Installs without OAuth credentials (API key / enterprise) are silently skipped; kill switch: `usage.enabled: false`.

## [0.15.6] - 2026-06-12

**Fixed**

- **`npx claude-rpc@latest setup` no longer opens a visible terminal running the daemon on Windows 11 — and no longer runs it from the npx cache.** The npx branch launched the daemon as `claude-rpc daemon` through a shell: PATH inside an npx run resolves that bare name back into npm's throwaway `_npx` cache (the very copy setup promotes away from), and the `cmd → .cmd shim → node` chain meant the hide/detach flags only applied to the first hop — the detached cmd loses its console, the grandchild node allocates a fresh one, and Windows 11 surfaces it as a visible Windows Terminal window. Closing that window killed the daemon; an `npm cache clean` would have stranded its source. Setup now resolves the global install explicitly (`npm root -g`) and spawns `node <global daemon.js>` directly — detached, windowless, cache-eviction-proof — falling back to a direct (still windowless) spawn of the npx copy only if npm can't be asked.

## [0.15.5] - 2026-06-12

**Changed**

- **Numbers now answer "is that a lot?" on their own.** `today` and `status` carry a ▲/▼ against your trailing 7-day average on active time, prompts, and tokens; standout days earn a percentile callout ("top 10% day", "best day yet"); the box gains today's estimated cost + lines added and a heat-colored 14-day sparkline. `week` compares against last week and marks the peak day with ◆. Down-arrows render gray, not red — a quiet day isn't a failure. All context lines disappear gracefully on fresh installs with no history to compare against.
- **Every bar, histogram, and heatmap is heat-graded.** One shared intensity ramp (calm green → amber → rust, matching the site palette) colors the weekly breakdown, hour-of-day histogram (your peak hour glows), the 13-week activity heatmap, and every ranked bar chart in `status` and the TUI — replacing the uniform magenta/green. Degrades to the exact previous monochrome output with `NO_COLOR` or piped output.
- **One milestone line on days that deserve it.** `today` prints a single ✶ line when you cross a round lifetime-token number that day (1B, 10B, …) or hit a day-N anniversary (50, 100, 365…). Complements the existing share nudges (which own streak records and round session/hour counts) without overlapping them.

## [0.15.4] - 2026-06-12

**Added**

- **`claude-rpc link` is now two-sided — link machines without a browser.** On a machine that's already verified, bare `claude-rpc link` mints the one-time code itself (the worker trusts its instanceId, which already proves the identity); `claude-rpc link <code>` on the new machine claims it, exactly as before. No GitHub login, no website — your main machine IS the code generator. The worker's `/pair/start` accepts the new machine credential alongside web sessions, with its own per-machine rate window; unverified machines are refused (the ✓ a claim grants must root in a proven identity). *(Needs a `wrangler deploy`.)*
- **Machine linking moved off the squads page to a dedicated `/link` page.** Linking installs is an identity operation, not a squads feature — it only lived there because that's where web login landed first. `claude-rpc.vercel.app/link` now owns both the first-time CLI connection and the add-a-machine code generator (and leads with the terminal-only path); `/squads` keeps a pointer and still notices a completed link on its own. Every CLI hint that said "log in at /squads" now teaches the two-sided `link` flow, and `setup` closes with a one-liner for multi-machine users.

## [0.15.3] - 2026-06-12

**Added**

- **One GitHub identity = one leaderboard identity, across machines.** Linking a second (third, …) install as the same GitHub user now MERGES it into your canonical profile instead of creating a parallel row: the board shows one entry whose tokens/sessions/hours are summed across machines (streak = your best machine), the extra handle is released, and every machine manages the same squads. A brand-new machine links with just `claude-rpc link <code>` — no profile dance first. Each machine's stats stay tracked as its own slice, so a flush from one never clobbers another.

## [0.15.2] - 2026-06-12

**Changed**

- **`setup` is loud when it works, one line when it doesn't.** A re-run where everything is already in place collapses to `✓ already set up — config current · hooks wired (8 events) · hook pipe verified` instead of re-printing the whole checklist; the closing "what now" block only renders when something changed; the npx→global promotion is skipped (silently) when the global bin is already this version, which also drops npm's install chatter; hooks only rewrite `~/.claude/settings.json` when the commands actually differ.

## [0.15.1] - 2026-06-12

**Changed**

- **The CLI's human-facing output got a full visual rework.** One symbol vocabulary and aligned columns everywhere; `claude-rpc setup` is now a phased checklist (binary → config → claude code → daemon) closing with a single "what now" block; profile mutations print a one-line confirmation plus a pointer at the next step instead of re-rendering the whole dashboard twice; the profile checklist teaches the web pairing flow (`claude-rpc link <code>`) with the gist dance as the no-browser fallback; failure hints are contextual — `doctor` is only suggested for problems it can actually diagnose; the unknown-command error explains version skew on its own line.

## [0.15.0] - 2026-06-12

**Added**

- **Squads — private mini-leaderboards with friends, with weekly resets.** `claude-rpc squad create "the night shift"` mints an invite code + link; friends join with `claude-rpc squad join SQ-XXXXXX` or **entirely in the browser**. Standings race on weekly deltas (reset Monday 00:00 UTC, lazily snapshotted — no cron) with lifetime alongside, at `claude-rpc.vercel.app/squad/<id>`. Capped (20 members, 5 squads each), code-gated, built on the stats profiles already publish — joining sends nothing new.
- **`claude-rpc link <code>`** — one-command web pairing. The /squads page shows a one-time code while you're logged in with GitHub; claiming it from the CLI verifies your profile (same ✓ as the gist flow, proven more directly) and unlocks browser-side squad management. The setup panels generate copy-on-click commands with YOUR GitHub login pre-filled as the handle, and the page detects the link landing automatically.
- **Web login.** "Log in with GitHub" on the site (no scopes — public identity only). The gist verification you already did doubles as account linking: the worker resolves your GitHub login to your profile, so squads can be created, joined, and managed without touching a terminal. Sessions are stateless signed tokens carrying only the public GitHub login; the browser never sees an instanceId. New worker routes: `/auth/login|callback|me`, `/squad/*`, `/squads/mine`.
- **VS Code extension** (`vscode-extension/`) — Claude Code's live status in the editor's status bar: working / thinking / **needs you** (highlighted when a permission prompt waits) / shipped / idle, with session tokens in the label and a hover card showing model, session stats, today's hours, and streak. Click for a menu: pause/resume the Discord card (writes the same `pause.json` marker as the CLI), open the dashboard (offers to start the server if it's down), start the daemon. It's a *viewer* over the existing state files — zero dependencies, no network surface, and it tracks **Claude Code only**, never your editor activity. Reads `state.json` directly, so it works even with the Discord daemon stopped. Build with `cd vscode-extension && npm run package`; not part of the npm package.

## [0.14.0] - 2026-06-11

**Added**

- **`claude-rpc pause [30m|2h]` / `claude-rpc resume`** — a global presence snooze. Privacy controls are per-project; this is the "I'm screen-sharing for an hour" switch that clears the Discord card everywhere, then resumes automatically when the timer expires (default 1h). The marker lives in the tmp state dir, so a reboot can't leave you paused forever.
- **`claude-rpc export [--csv] [--out <file>]`** — dump the full aggregate as JSON, or the per-day breakdown as CSV, straight from the CLI. Same data the dashboard's export routes serve, without starting the server.
- **Concurrent sessions show as a native Discord party** — with two or more live sessions the card now reads "(2 of 2)" via Discord's party field, instead of relying on a rotation frame. Opt out with `showPartySize: false`.

**Fixed**

- **Worker: profile publishes were silently rate-limited on almost every flush.** `/report` and `/profile` shared one per-instance rate key, and the daemon flushes community totals then the profile back-to-back — so whenever community had a delta, the profile publish 429'd and the board only updated on cycles with nothing to report. Rate keys are now scoped per endpoint. *(Needs a `wrangler deploy`.)*
- **Worker: expired profiles no longer squat their handle forever.** Unverified profiles expire after 90 days, but the `handle:` mapping had no TTL — the handle stayed claimed by a dead row and every new claimant got 409 "handle taken". An orphaned handle is now released on the next claim (and cleaned up when a profile lookup 404s).
- **Worktrees and submodules get branch / repo / GitHub-button detection.** `git.js` assumed `.git` is a directory; in a linked worktree it's a `gitdir:` pointer file, so detection silently vanished — increasingly common now that agents work in worktrees. The pointer (and the worktree's `commondir`) is now followed for HEAD, config, and the just-shipped commit subject.
- **Fable 5 is recognized end-to-end.** `claude-fable-5` previously rendered as just "Claude" on the card, billed at Sonnet rates in cost estimates, and missed `modelAssets` art. Now: "Fable 5", $10/$50 per MTok, and a `modelAssets.fable` slot. Opus 4.6+ pricing also updated to current list rates ($5/$25 — it had been sitting at the 4.1-era $15/$75) and `claude-opus-4-8` added.
- **Quoted shell separators can't fake a ship celebration.** `echo "run git push && rejoice"` split on the `&&` inside the quotes and classified as a push; quoted spans are now blanked before splitting.
- **Stale comments in `applyIdle` contradicted the actual `idleWhenOpen` default** (false); they now describe the real behavior.

**Changed**

- **Scans skip disk writes when nothing changed.** The 5-minute rescan rewrote the full scan cache (potentially tens of MB) and recomputed + rewrote the aggregate even when zero transcripts changed. No-op scans now return the existing aggregate untouched — recomputing only when data changed or the local day rolled (streaks and "today" fields go stale at midnight).
- **Active transcripts parse incrementally.** A live session's growing JSONL was fully re-read and re-parsed on every rescan; the scan cache now records a byte offset per transcript and parses only the appended tail (the same append-only trick `readSessionTokens` already used). Anything that breaks the append assumption falls back to a full parse.
- **The daemon watches directories, not files.** `state.json` and `aggregate.json` are written via atomic rename, which kills an inode-based file watcher after the first write; the 4s tick and 30s poll were silently carrying the load. Directory watchers survive renames, work before the file first exists, and also pick up `pause.json` instantly.
- **The daemon's per-transcript caches are LRU-capped** (512 entries) instead of growing one entry per file ever observed across a weeks-long run.

## [0.13.7] - 2026-06-06

**Fixed**

- **Dashboard auto-update works again (and release binaries carry the right version).** The Electron dashboard's own `package.json` had sat at `0.5.0` since the 0.5 days, and electron-builder takes both artifact names and the auto-update feed (`latest*.yml`) from it — so every release since shipped `claude-rpc-0.5.0-*` binaries and a feed that told installed dashboards they were already current. Auto-update never fired. The release build now syncs the dashboard version from the root package before building, so this can't drift again; installed dashboards will see this release as an update.

## [0.13.6] - 2026-06-06

**Security**

- **Dashboard tables escape HTML.** Project, file, bash-command, web-domain, model, language, and subagent names are interpolated into the local dashboard via `innerHTML` — and they ultimately come from directory/file names on disk, so a repo named like an HTML tag could inject markup into the stats page. All such values now pass through an escape helper before rendering. (The year-in-review page already escaped consistently.)
- **The local stats server rejects non-local `Host` headers.** Binding to `127.0.0.1` blocks the LAN but not DNS rebinding: a malicious website could point its own hostname at `127.0.0.1`, become "same-origin" with the dashboard, and read your full aggregate via `/api/export.json`. Requests whose `Host` isn't `localhost`/`127.0.0.1`/`::1` now get a 403.
- **The Electron dashboard only opens web URLs.** The `open-external` IPC channel passed any renderer-supplied string to `shell.openExternal`; it now parses the URL and allows only `http:`/`https:`.
- **Worker: `/verify/check` is rate-limited and its gist scan is bounded.** The endpoint triggers outbound GitHub fetches (up to ~21 on the no-gistId fallback) with no rate limit, making the worker an unauthenticated outbound-request amplifier. It now shares the per-IP limiter with `/verify/start`, and the fallback scan is capped at 10 raw-file fetches.
- **Worker: `/leaderboard` bounds its KV fan-out.** The handler listed every `pf:` key (instanceIds are mintable, so unbounded) and did one KV read per profile — past ~1000 profiles a single request would blow the Workers subrequest cap. The list is now capped at 500 profiles per request.

**Fixed**

- **A torn-down Discord connection no longer strands in-flight presence updates.** `destroy()` cleared pending requests without rejecting them, so a `setActivity` awaited at the moment the watchdog bounced the client hung forever. Requests also gained a 10s reply deadline: a half-open pipe that acks writes but never answers previously froze presence on a stale frame with no self-heal — a timeout now surfaces as a connection error and forces a reconnect.
- **`releaseLock` can no longer delete a sibling's reclaimed lock.** If a state-write held the lock past the 2s staleness window and another process reclaimed it, the first writer's release would unlink the new owner's lock by path, collapsing mutual exclusion for a third writer. Release now verifies inode ownership before unlinking.
- **`cleanDisplayName`'s control-character regex is written in escaped form.** The source contained literal control bytes (0x00–0x1F) inside the regex class — functionally correct, but invisible in terminals and diffs, where it rendered as `[ -]` and read as "strip spaces and dashes" (it fooled two automated reviews into reporting a bug that wasn't there). Now written as `\u0000-\u001f\u007f` escapes, with regression tests pinning that spaces and punctuation survive.

## [0.13.5] - 2026-06-05

**Changed**

- **Zero runtime dependencies.** Dropped the last runtime dependency, `@xhayper/discord-rpc`, by hand-rolling the small slice of Discord Rich Presence we actually use — the local IPC client in [`src/discord-ipc.js`](src/discord-ipc.js). That library pulled in ~10 transitive packages (undici, ws, the `@discordjs/*` stack) to talk to a local socket; presence over IPC is, on the wire, an 8-byte header plus a JSON blob. The activity → payload mapping is a faithful copy of the old library's, so the rendered card is unchanged. The published package now installs **nothing** beyond its own source — the smallest possible supply-chain surface.

**Security / supply chain**

- **CI Actions are pinned to full commit SHAs** (with a Dependabot group to keep them current). The release pipeline holds `id-token: write` plus the npm token, so a moved tag on a third-party action was a real injection path; SHA pins close it. Publishing also declares `provenance` in `publishConfig`, so every release must carry its SLSA provenance attestation, not just when the `--provenance` flag is remembered.

## [0.13.4] - 2026-06-05

**Fixed**

- **Heavy users are no longer silently dropped from community totals.** The community report sends a delta against a cursor, so the *first* report carried your entire lifetime token total as one delta. For anyone past the 5B per-report cap (cache-read tokens add up fast) that report 400'd — and since the cursor only advances on success, it would 400 *forever*, excluding every heavy user from the totals. The client now **clamps each report's delta to the per-report cap and streams the backfill** over successive flushes, so any lifetime total gets counted no matter how large, while the per-report cap still bounds abuse. (The leaderboard *profile* cap is a separate, generous 1-trillion ceiling — it was never the issue here.)

## [0.13.3] - 2026-06-05

**Fixed**

- **Publishing a profile no longer fails with HTTP 400 for established users.** The profile flush sent *deltas* against a cursor, so the first publish carried your entire lifetime total as one delta — which blew past the worker's per-report cap for anyone with billions of tokens (cache-read tokens add up fast). Profiles now report **absolute lifetime totals**, which the worker **stores directly** (idempotent, no cursor, no double-count) clamped to a generous plausibility ceiling. The board now matches your real aggregate exactly, and a multi-billion-token total goes through fine.
- **`profile verify` now publishes your profile first**, so it can't fail with "create your profile first" if you verify before publishing.

## [0.13.2] - 2026-06-05

**Fixed**

- **GitHub verification is now instant and foolproof.** It previously scanned GitHub's gist-*list* API (which lags for brand-new gists) for a token under a self-asserted username — so it perpetually missed, and silently failed if the gist landed under a different account than the one you set. Now the CLI hands the worker the gist ID it just created; the worker fetches **that gist directly** (no indexing lag) and reads its **real owner**, which becomes the verified identity. Whatever account `gh`/`GH_TOKEN` actually owns the gist is the one that gets the ✓ — no guessing, no waiting, works on the first try. The verification token is also reused across retries instead of regenerated.

**Added**

- **`claude-rpc profile publish`** — a one-shot publish so you appear on the leaderboard immediately, instead of waiting for the daemon's next flush.
- A real **empty-state** on `/leaderboard` (a "be the first builder" panel with the exact commands) instead of a bare table row.

## [0.13.1] - 2026-06-04

**Added**

- **Easier install.** A one-liner `curl -fsSL https://claude-rpc.vercel.app/install | sh` (detects Node → npm, or falls back to the prebuilt Apple-Silicon binary, then runs `setup`), plus a Homebrew formula (`brew install rar-file/claude-rpc/claude-rpc`).
- **`claude-rpc doctor --fix` is now targeted.** It applies only the repairs the checklist actually flagged — re-wire hooks, rebuild the aggregate, (re)start the daemon — in dependency order, reporting each, instead of blindly re-running setup. Discord-desktop issues are surfaced as advice (not auto-fixable).
- **Public leaderboard + profiles (opt-in).** `claude-rpc profile [set|on|off|verify]` publishes a public profile (handle, name, optional GitHub) to a leaderboard at [`/leaderboard`](https://claude-rpc.vercel.app/leaderboard), with shareable `/u/<handle>` pages. **Hybrid trust model:** anyone can appear, but a GitHub-verified profile (proved via a public gist) earns a ✓ and ranks first; unverified entries are capped and greyed. The worker accepts only server-validated deltas with plausibility caps + per-IP/per-instance rate limits — self-reported usage can't be made fraud-proof, so the design makes cheating bounded and attributable. Off by default; nothing publishes until you opt in.

**Fixed**

- **Concurrent hooks no longer lose counter updates.** Claude Code fires lifecycle hooks in bursts, and subagents / parallel sessions run several `claude-rpc hook` processes at once. Each did a read-modify-write of `state.json` with no cross-process lock, so the last writer won and the others' message / tool / token increments were silently dropped. Writes now serialize through an exclusive lock file (best-effort, with stale-lock reclaim), and each writer uses a per-PID temp file so the atomic rename can't clobber a sibling mid-write.
- **The daemon could crash at startup when `config.json` didn't exist yet.** `fs.watch` on the missing config path threw `ENOENT` — exactly the case the config loader was already hardened against. The watcher is now guarded and attaches once the file appears.
- **Streaks and "days since first" could be off by one around daylight-saving transitions.** The day math subtracted local-midnight timestamps, which span 23 or 25 hours across a DST change; it now uses DST-immune calendar day indices. The scanner also rejects malformed / implausible transcript timestamps before they can inflate lifetime totals.
- **The "shipped" celebration false-fired on quoted mentions of git.** `echo "remember to git push"` or `git commit -m "prep for git push"` could trip the ship animation. Detection now tokenizes each shell segment and only fires when the segment's actual leading command is `git`/`gh` (handling env prefixes, `sudo`, binary paths, and git global flags like `-C`).
- **A missing desktop-notify binary could crash the daemon.** `desktopNotify` spawned the OS notifier (`notify-send` etc.) without an `error` listener, so an absent binary surfaced as an uncaught async exception. It's now swallowed — the helper truly never throws.
- **Project names with a segment literally named `C` were mangled** in the rare path-slug fallback (a Windows drive-letter filter was too broad).

**Performance**

- **The scanner stops reading whole transcripts when it doesn't need to.** Resolving a live session's cwd now reads only the file head instead of the entire multi-MB transcript; the live token count parses only the appended tail from a cached byte offset instead of re-reading the whole growing file on every 4-second daemon tick; and full parses iterate lines lazily rather than materializing a second copy of the file.
- **The daemon resolves presence state once per tick** (idle / shipped / trigger / privacy overlays + live-token enrichment) instead of running the chain twice — removing wasted work and a path where the clear-vs-push decision and the rendered frame could disagree.

**Infrastructure**

- **Community-totals worker:** added a per-IP rate limit on the report endpoint (the per-instance limit alone was defeatable by rotating anonymous IDs) and removed an inaccurate code comment.
- **Release CI** now gates the npm publish behind the binary build, asserts the pushed tag matches `package.json`, runs the worker's own test suite, and runs across Node 18 / 20 / 22.
- **Dev tooling:** ESLint + Prettier configs, `jsconfig` / `npm run typecheck`, plus `CONTRIBUTING.md`, a code of conduct, and issue / PR templates.
- **Landing page** loads its changelog live from the GitHub releases API (no more stale version stamps) and now sends security headers (CSP, `nosniff`, `Referrer-Policy`, `X-Frame-Options`).

## [0.13.0] - 2026-06-04

**Added**

- **`npx claude-rpc setup` — a true one-command install.** Previously you had to `npm install -g` first, then `setup`, then `start`. Now a single `npx claude-rpc setup` does everything. Because npx runs from npm's throwaway `_npx` cache (which is deleted the moment npx exits), a hook wired to the PATH-resolved `claude-rpc` bin would dangle — so setup now detects npx (new `IS_NPX`) and self-promotes to a real global install before wiring anything.
- **`setup` auto-starts the daemon.** No more separate `claude-rpc start` after setup — the card shows up immediately. In npx mode the daemon is launched from the freshly-promoted global bin (our own script tree is the ephemeral cache). Best-effort: a start hiccup never makes `setup` look failed. Manage it afterward with `claude-rpc start | stop | status`.
- **Claude Wrapped finale now has a real Share button.** The old "copy link" copied the local `localhost:47474` dashboard URL — useless to anyone you shared it with. The new Share uses the native share sheet (mobile) and falls back to copying a stats summary plus the public install link.

**Changed**

- **The Discord presence button is now an install call-to-action.** The card on your profile is the project's main distribution surface, so the default button changed from a bare repo link labelled "Claude Code" to **"Get claude-rpc →"** pointing at the landing page (`?ref=discord` for attribution). Existing configs are migrated automatically; customized buttons are left untouched. When the cwd is a github repo, the auto "View on GitHub →" button still shows alongside it.
- **Shareable artifacts point home.** Every poster / calendar / profile / session card footer now carries `claude-rpc.vercel.app`, so anyone who sees a shared image knows where to get it. The landing page and README lead with the `npx` one-liner.

**Fixed**

- **The MCP `get_today` tool showed the wrong day for anyone not on UTC.** The scanner *writes* `byDay` buckets keyed by local date (`dayKey`) and `format.js` reads them the same way, but the MCP "today" tool keyed by a UTC date slice — so once local and UTC dates diverged (e.g. evening in CEST), it surfaced the wrong or an empty bucket. Now keyed by the same local `dayKey`.
- **CI `npm publish` no longer fails the release run.** The publish job 403'd on every release because the version was already published manually before the tag push. It now checks the registry first and skips cleanly when the version already exists.

## [0.12.1] - 2026-06-02

**Added**

- **`claude-rpc mcp install` — one-command MCP setup.** Wiring the stats MCP server into Claude Code used to mean hand-typing `claude mcp add claude-rpc -- claude-rpc mcp`. Now `claude-rpc mcp install` does it for you: it resolves the right invocation for your install mode (packaged exe / npm bin / dev source) and runs `claude mcp add` under the hood (idempotent — re-running replaces the old entry). `--project`/`--local` to change scope (default `user`); `claude-rpc mcp uninstall` removes it. Falls back to printing the exact manual command if the `claude` CLI isn't on PATH.

## [0.12.0] - 2026-06-02

**Fixed**

- **Token and cost totals were inflated ~2–3× by duplicate `usage` accounting.** Claude Code records a single assistant message (one `message.id`) across several JSONL lines — one per content block (thinking / text / tool_use) — and repeats the *same* `usage` object on every line. The scanner summed it each time, so a 3-block turn counted its input/output/cache tokens (and its turn + per-model split) three times. Usage, cost, turns, and the model split are now counted **once per `message.id`**; content blocks (tool calls, edits, lines) still count per line since those are distinct. Scanner cache version bumped 3 → 4 — the next scan re-parses every transcript once to correct historical totals.

## [0.11.2] - 2026-06-02

**Changed**

- **Claude Wrapped got a visual glow-up.** Flat slide backgrounds are now bold duotone gradients; each stat slide carries a giant faded background number/word (the headline stat, e.g. a huge "53" behind your hours); a soft floating glow sits behind the content; and slide content blur-rises in instead of a plain fade. Purely cosmetic — same data, same flow.

## [0.11.1] - 2026-06-02

**Fixed**

- **Claude Wrapped's finale buttons (replay / poster / copy link) now work.** The full-screen tap/arrow navigation zones (`z-index: 20`) were layered on top of the finale's action buttons, so every click hit the nav layer instead of the button. The summary card + actions now sit above the tap zones (`z-index: 24`).

## [0.11.0] - 2026-06-02

**Added**

- **Claude Wrapped — a fully-animated year-in-review.** Visit `/wrapped` on the local dashboard (or run `claude-rpc wrapped`) for a Spotify-Wrapped-style story: an animated intro, count-up stat slides (hours, sessions, prompts, tokens), then your top language, hotspot file, peak day/hour, model split (animated bars), lines written, and a shareable summary card you can screenshot. Story-style progress bars, auto-advance, click/arrow-key navigation, and space-to-pause. Backed by a new `GET /api/wrapped` endpoint; assets in `src/server/assets/wrapped.*`. The dashboard header now links to it (✦ Wrapped).

## [0.10.0] - 2026-06-02

**Added — ten features**

- **MCP server — `claude-rpc mcp`.** Exposes your own Claude Code stats to Claude as MCP tools (`get_lifetime_stats`, `get_today`, `get_top_files`, `get_model_split`), so mid-session you can ask "how long have I worked today?" or "what's my hottest file?". Wire it up: `claude mcp add claude-rpc -- claude-rpc mcp`. Minimal stdio JSON-RPC, no SDK dependency.
- **Status webhooks.** When `webhook.url` is set, the daemon POSTs a small JSON body on status transitions you opt into (`webhook.on`, default `["shipped","notification"]`) — pair it with a Slack/Discord incoming webhook or your own endpoint. Best-effort, fire-and-forget.
- **Desktop notifications.** `notify.enabled: true` raises a native OS notification (notify-send / osascript / PowerShell toast) when Claude needs you, so a permission prompt isn't missed while you're tabbed away.
- **Goals & targets.** Set `goals.dailyHours` / `dailyPrompts` / `weeklyHours`; a presence frame shows progress ("2.1h / 4h · 52%") via `{goalLabel}` / `{goalHit}`.
- **`claude-rpc statusline`.** A one-line status for tmux / starship / shell prompts and Claude Code's own statusline. `--template` to customize.
- **`claude-rpc session-card`.** A shareable SVG recap of the current session (project, model, duration, prompts, tools, files, tokens, cost).
- **`claude-rpc calendar`.** A GitHub-contributions-style year activity heatmap as an embeddable SVG (`--out` / `--gist`).
- **Cost budget + alerts.** Set `budget.monthly`; `{budgetLabel}` / `{budgetWarn}` and the dashboard warn as month-to-date spend approaches it.
- **Custom command triggers.** `triggers: [{ match, details, state }]` maps a regex against the Bash command Claude runs to a brief presence frame — generalizes ship-detection (e.g. `npm test` → "Running tests in {project}").
- **`claude-rpc doctor --fix`.** Auto-repairs the common breakages doctor flags: re-runs setup (re-seeds/migrates config, re-wires hooks) and restarts the daemon.

## [0.9.1] - 2026-06-02

**Changed**

- **`idleWhenOpen` now defaults to `false` — a closed terminal clears the card fast.** Closing a terminal kills Claude Code without firing its `SessionEnd` hook, so the daemon can't distinguish "closed" from "paused" — it only sees the transcript stop. The 0.8.0 default (`true`) lingered as `idle` for the full `staleSessionMin` (5 min) in that case. The new default clears within ~90s of the transcript going quiet, matching most people's "I just close the terminal" workflow. Opt back into the pause-friendly behavior (card stays `idle` through short pauses, clears at the 5-min backstop) with `"idleWhenOpen": true`. A graceful exit (Ctrl+C / `/exit`) still clears instantly via `SessionEnd`, and a live transcript anywhere still keeps the card up.

## [0.9.0] - 2026-06-02

**Added**

- **`claude-rpc github-stat` — an embeddable profile stat card.** Renders a compact paper/terracotta SVG of your all-time stats (time with Claude, sessions, streak, prompts, tokens, net lines, top language, cost) sized for a GitHub profile README. `--handle <name>` stamps your handle, `--out <file>` writes the SVG, and `--gist` publishes to a gist so the README image auto-refreshes when you re-run it (same gist plumbing as `badge --gist`).
- **Session-duration milestones.** A celebratory frame pops for ~5 minutes when a live session crosses 1h/2h/3h/5h/8h/12h ("2-hour session"). New `{sessionMilestoneHit}` / `{sessionMilestoneLabel}` template vars; stateless (derived from elapsed time).
- **PR / issue / release "shipped" detection.** The just-shipped overlay now recognizes `gh pr create`, `gh issue create`, and `gh release create` alongside `git push`/`commit`. `{justShippedLabel}` adapts: "Opened a pull request", "Opened an issue", "Tagged v1.0". `classifyShip()` is exported and tested.
- **Model split.** The scanner now tracks per-model turns/tokens/cost (`aggregate.modelSplit`, `byModel`). New `{modelSplitLabel}` ("Opus 72% · Sonnet 28%"), `{topModelPretty}`, `{topModelShareLabel}` vars, plus a "Model split" idle frame.
- **Hotspot aging.** Top edited files carry `lastEditedTs` / `daysSinceLastEdit`; the Hotspot frame now reads "73 edits · 3d since last edit" via `{topEditedAgeLabel}` / `{topEditedDaysAgo}`.
- **Billable-vs-cache token clarity.** New `{allFreshTokens}` (input+output), `{allCachePct}`, `{allCachePctLabel}` ("82% from cache") so the lumped token total isn't mistaken for billable spend.

**Changed**

- Scanner cache version bumped 2 → 3 — the next scan re-parses every transcript once to populate the new per-model and last-edit fields. Automatic; no action needed.
- The website's hero install command is now a true one-liner: `npm install -g claude-rpc && claude-rpc setup && claude-rpc start`.

## [0.8.1] - 2026-06-02

**Fixed**

- **Upgrades now actually update the presence button.** The 0.8.0 default-button change (→ project repo) never reached existing users: their `config.json` carries its own `buttons` array, and config arrays *replace* rather than deep-merge, so the new default was always overridden. The daemon now runs `migrateConfig()` on startup, which rewrites a button still pointing at the old `claude.com/claude-code` URL to the repo — so a plain `npm i -g claude-rpc@latest` + `claude-rpc stop && start` picks it up, no `setup` re-run needed. Only the verbatim old default is touched; any button you've customized (label or URL) is left alone. `migrateConfig` gained a `silent` option so the startup run stays quiet in the daemon log unless it actually changes something.

## [0.8.0] - 2026-06-02

**Reliability**

- **The card now stays as `idle` while a Claude Code session is open but paused, instead of vanishing.** Previously, once no transcript was being written anywhere on disk, `applyIdle` went straight to `stale` (and `hideWhenStale` cleared the card) within ~90–120s — so stepping away for a couple of minutes with the session still open dropped your presence entirely. Now an open-but-quiet session resolves to `idle`; only an authoritative `SessionEnd` hook or the full `staleSessionMin` (5min) dormancy window drops to `stale`. New `idleWhenOpen` config flag (default `true`) — set it `false` to restore the old aggressive clear.
- **Auto-healing Discord RPC connection.** The daemon already reconnected on `disconnected` events and login failures, but two silent-death modes slipped through: a `setActivity` call failing on a broken IPC pipe (Discord restart / socket reset / OS sleep) left `connected=true` and the daemon dark forever, and a half-open client (connected flag set, user handle gone) never recovered. `setActivity` failures that look connection-level now tear down and force a backoff reconnect, and a 30s **watchdog** guarantees the daemon always converges back to a live connection (forces a reconnect on half-open clients and whenever it's down with no retry pending). This is the most common "it just stopped showing up" failure — the daemon now self-heals instead of needing a manual restart.

**Changed**

- **Default presence button now points at the project repo** (`github.com/rar-file/claude-rpc`) instead of the Claude Code website, so people who see your card can find the tool.

## [0.7.4] - 2026-05-24

**Docs / transparency**

- **Added [`SECURITY.md`](SECURITY.md) — a full behavior disclosure.** Documents every sensitive thing claude-rpc does and why: the `HKCU` Run-key startup entry, the hook commands wired into Claude Code's `settings.json`, all outbound network (community totals, opt-in gist publishing, Discord-side GIF assets), every local subprocess, and the exact telemetry payload (cross-checked against the Worker's `validateReport`). It exists so supply-chain scanners (Socket.dev et al.) and security-conscious users have a single auditable reference — the flagged persistence and hook-injection behaviors are inherent to the tool, `HKCU`-scoped, and reversible (`claude-rpc uninstall`). README now links it from both the `install` callout and the community-totals section, and it ships in the npm tarball (`files`).

**Fixed**

- **`doctor` no longer false-warns on a healthy Discord connection.** The IPC check grepped the log only for a recent "Discord RPC connected" line, but the daemon connects once and stays connected without re-logging — so a long-lived, actively-pushing daemon read as a warning. It now also treats recent "Presence updated" / "Presence cleared" lines as proof of a live connection (both only log after the daemon's `connected` guard), and respects a later "retry in Ns" / "login failed" / "disconnected" as a drop.

## [0.7.3] - 2026-05-24

**Features**

- **System tray for the Electron app.** Closing the window now hides to a tray icon instead of quitting; a right-click menu offers Open settings, Open web dashboard, Start/Stop/Restart daemon (label reflects live status), and Quit. The daemon actions reuse the in-window control path, and the tray label stays in sync whether you drive the daemon from the tray or the Daemon tab. Ships a small on-brand diamond icon (`dashboard/tray.png`).
- **Data export (web + GUI).** New `GET /api/export.json` (raw aggregate) and `GET /api/export.csv` (daily rows: active time, sessions, prompts, tools, lines, cost, tokens, notifications) with `content-disposition: attachment`; footer links on the web dashboard. The Electron Stats tab gains ⬇ JSON / ⬇ CSV buttons that save via a native dialog. CSV columns are shared by `aggregateToCsv` (server) and the GUI's converter.
- **Native chart hover tooltips.** The activity chart and churn sparkline now show exact per-day numbers on hover — a cursor-following tooltip that maps pointer position to a data point. No charting library: the SVG charts are still hand-rolled, so the offline/SEA/no-deps guarantees are untouched.
- **Privacy / Workspaces tab in the GUI.** Lists discovered projects (real cwds recovered from transcript heads) with a Public / Name-only / Hidden toggle each. Toggles write a central path→visibility map in `~/.claude-rpc/private-list.json` — no files are written into your project directories. `src/privacy.js` resolution gains this map as a runtime layer just under per-project `.claude-rpc.json`, where an explicit `public` also opts a repo out of `gh` auto-hide. `setCwdVisibility` / `listVisibility` are the new programmatic surface.

**Internals**

- **Web dashboard assets split out of `src/server/page.js`.** The ~1,260-line string monolith (CSS + HTML + client JS as one file) is now three real, tool-friendly files under `src/server/assets/` — `dashboard.css`, `dashboard.html` (with `{{STYLES}}` / `{{SCRIPT}}` / `{{PORT}}` tokens), and `dashboard.client.js`. `page.js` shrinks to a ~30-line composer. A new `src/server/assets.js` `loadAsset()` reads from disk in dev/npm and from the SEA blob (via `node:sea` `getAsset()`) in the packaged exe — so the single-binary, no-runtime-deps, works-offline guarantees hold. `sea-config.json` gains an `assets` map. Rendered HTML is byte-for-byte identical to before; no user-facing change.

## [0.7.2] - 2026-05-24

**Design**

- **Web dashboard + Electron GUI reskinned** to match the landing page's warm-paper / terracotta "brutalist" look: hard offset shadows (`--shadow*` now solid `Npx Npx 0`), 2px ink borders, dashed dividers, rotated tape-label accents (the live rail wears a "LIVE PREVIEW" tag), and display/mono type via Space Grotesk + JetBrains Mono. The dashboard drops its dark/light toggle and `html.light` theme — paper is the only mode now; backwards-compat `--bg`/`--text`/etc. vars are mapped onto the new palette so existing markup resolves unchanged. CSS-only; no HTML/JS structure changed.

## [0.7.1] - 2026-05-24

**Install / first-run**

- **Community totals on by default for fresh installs.** `seedConfig` now mints an anonymous `instanceId` at the same time it writes the freshly-seeded config, so the new `community.enabled: true` default in `DEFAULT_CONFIG` is immediately actionable — without an id, `flushCommunity` bails with `no-instance-id` and the badge counters would never see fresh installs. Users who want out: `claude-rpc community off`.
- **Pre-v0.7 upgraders preserved off.** `migrateConfig` writes an explicit `community: { enabled: false }` into any user config that has no `community` block, so the deep-merge in `loadConfig` does NOT silently flip them on. The existing `claude-rpc community on` consent flow remains the only path to enable for these users — the v0.7.0 privacy claim is preserved verbatim.
- **`claude-rpc setup` and `claude-rpc install` are now aliases.** Both register Claude Code hooks AND the Windows startup entry (`HKCU\…\Run\ClaudeRPC`). Previously `setup` skipped the startup step; in practice users expected one command to do both. Non-Windows: the existing one-line warning still prints, no functional change.

**Tests**

- 210 → 216 in the main suite (worker suite unchanged at 19). New coverage in `test/install.test.js`: `migrate` writes `enabled:false` for pre-v0.7 upgraders, leaves explicit user community blocks untouched, doesn't flip an opted-out user back on; `seed` mints an instanceId when the default is `enabled:true`, never overwrites a pre-existing id, doesn't mint when disabled.

## [0.7.0] - 2026-05-24

**New presence frames**

- **Compaction-only state.** Claude Code's `PreCompact` hook now drives a dedicated `byStatus.compacting` template — "Compacting context in {project}" with the trigger (manual/auto) on the large image. Previously a context squeeze rendered as "Thinking…" for the 10-60s it can take. `PostCompact` clears the marker and the card returns to idle until the next real hook. The trigger surfaces as `{compactTrigger}` / `{compactTriggerLabel}` and elapsed as `{compactDuration}`.
- **Tool-duration spotlight.** `PreToolUse` now stamps `state.toolStartedAt`; `format.fmtToolElapsed` derives a `{toolElapsed}` var, populated only when the running tool has exceeded a 5-second threshold (no flicker on quick reads). The default working frame became `{currentToolPretty} · {currentFilePretty} · {toolElapsed} · {tokensLabel}` — so a long `npm test` reads "Bash · 2.5min" without the empty-separator collapse from v0.6.3 having to do extra work.
- **Just-shipped overlay.** `PostToolUse` on a Bash command containing `git push` or `git commit` (chains like `git add . && git commit` included) stamps `state.justShipped` + branch + commit subject (read from `.git/COMMIT_EDITMSG` with a fallback to `.git/logs/HEAD`). A new `applyShipped(state, cfg)` helper promotes status to `'shipped'` for the next `shippedFrameSec` (default 60) seconds, then yields back to the underlying status. The new `byStatus.shipped` frame reads "Just shipped in {project}" with `{justShippedLabel}` ("Pushed to main" / "Committed on feat/x") on the image. Stale always wins — no celebration when Claude is closed.

**Shareable badges**

- **`claude-rpc badge --gist`.** Publishes the rendered badge SVG to your own GitHub gist; raw URL is README-ready. First successful publish records `gist.id` + `gist.owner` in `config.json` so subsequent runs *update* the same gist — the README URL stays stable across re-runs. Uses `gh` when available (no token plumbing), falls back to GitHub REST with `GH_TOKEN`/`GITHUB_TOKEN` (scope: `gist`).

**Community totals (opt-in)**

- **Cloudflare Worker at [`worker/`](worker/).** A small Worker (one file + a vendored badge renderer, no deps) accepts opt-in counter reports and serves `GET /sessions.svg` / `GET /tokens.svg` for the claude-rpc README. Source lives in this repo so the privacy story is auditable. KV namespace `TOTALS` holds two running sums plus a 30-day `seen:<id>` dedup marker and a 60-second rate-limiter. `validateReport` strictly enforces the schema; the request payload has no room for IPs, paths, prompts, models, repos, or costs.
- **`claude-rpc community on|off|status|report`.** Disabled by default. `on` prints the exact payload that will be sent and asks for explicit `y` confirmation before flipping `community.enabled` + minting a UUID v4 instance id. The daemon flushes deltas every `community.flushIntervalMin` (default 30 min) via `flushCommunity()` — best-effort, the cursor only advances on a successful POST so a network outage doesn't lose deltas. `report` does a one-shot manual flush for testing.

**Internals**

- `src/git.js` gains `detectLastCommitSubject(cwd, max)` — reads `.git/COMMIT_EDITMSG` first, falls back to parsing the last line of `.git/logs/HEAD`. Not cached (the only caller is the just-shipped hook flow, which needs the fresh value).
- New `src/gist.js` (~150 LOC) — `gh`-first publisher with a REST fallback, exports `publishGistFile`, `rawGistUrl`, `gistMarkdown`, `parseGistUrl`, `hasGh`. Tests cover the pure helpers; spawn/fetch paths are exercised manually since they need real auth.
- New `src/community.js` (~120 LOC) — opt-in flush client. `flushCommunity` accepts an injected `fetchImpl` for hermetic tests against an in-memory KV stub.
- `state.js` gains `compactStartedAt`, `compactTrigger`, `toolStartedAt`, `justShipped` (+ kind / subject / branch). All cleared on `SessionStart`.
- `default-config.js` adds `statusAssets.compacting`, `statusAssets.shipped`, `statusIcons` for both, the `byStatus.compacting` and `byStatus.shipped` templates, and the new `shippedFrameSec` / `gist` / `community` config blocks.

**Tests**

- 134 → 203 tests in the main suite plus 19 in the new `worker/test/`. Coverage includes the PreCompact/PostCompact flow, the just-shipped detection (including chained Bash), `applyShipped` under every status, `fmtToolElapsed` at boundaries, the gist URL parser + markdown builder, the community payload builder + every flush branch (no-delta / 429 / 5xx / network), and every worker route handler.

## [0.6.3] - 2026-05-23

**Fixed**

- Working-state card no longer renders `Bash · · 0 tokens`. Two contributing bugs:
  - `{currentFilePretty}` is empty for tools without a `file_path` (Bash, WebFetch, Task) — that left orphan ` · ` separators. `fillTemplate` now collapses empty separator runs: split on `·`, trim, drop empties, rejoin. Templates without `·` pass through untouched.
  - `{tokensFmt}` rendered `0` before any session tokens had accrued. New `{tokensLabel}` var returns `'2.3k tokens'` when tokens > 0 and an empty string otherwise. Combined with the collapse, the working frame degrades gracefully: `Bash` alone before tokens, then `Bash · 2.3k tokens`, then `Edit · src/foo.js · 2.3k tokens` once a file is being edited.
- `migrateConfig` migrates the verbatim old `working` / `thinking` state templates to the new `{tokensLabel}` form. Customized templates are left untouched.

## [0.6.2] - 2026-05-23

**Security / privacy**

- **Username no longer leaks to Discord when `cwd` is the home directory.** A user running Claude Code from `C:\Users\lucas` or `/home/lucas` would see the card render as "Idle in lucas" — exposing their OS account name to anyone with friends-list visibility. The buildVars now detects when `cwd` equals `$HOME` / `$USERPROFILE` or when `basename(cwd)` matches `$USER` / `$USERNAME`, and falls back to `appName` ("Idle in Claude Code"). Both the displayed `{project}` and the raw `{cwd}` template var are sanitised. Path separators normalised so the check works cross-platform.

**Resilience**

- **Stale-detection fast path.** `applyIdle` now goes straight to `stale` (clearing the card via `hideWhenStale`) when no transcripts have been written anywhere on disk in the last 90s, instead of waiting the full `staleSessionMin` (default 5min). Catches force-quit / OS-sleep / crash cases where `SessionEnd` doesn't fire — the card clears in ~90–120s of close instead of 5min. Paused-but-open Claude (transcripts still being written) is unaffected. The `staleSessionMin` 5-min fallback is still in place for the edge case where transcript mtime is fresh but the hook channel is silent.

Combined effect: Lucas's friends never see "Idle in lucas" again, and the card disappears within ~2min of him closing Claude even if SessionEnd didn't fire.

## [0.6.1] - 2026-05-23

**Fixed**

- Windows + npm-install setup logged `hook pipe ✗ spawn error: spawnSync claude-rpc ENOENT` after install. The setup test-fire was calling `spawnSync('claude-rpc', [...])` raw, and Node doesn't apply `PATHEXT` on Windows — `claude-rpc.cmd` (the npm-shipped shim) couldn't be resolved without going through `cmd.exe`. The fix sets `shell: true` on the verify spawn under npm-install + Windows, mirroring how Claude Code actually invokes the hook string at runtime. Real hook firing was always fine; only the post-install verification probe was broken. Regression test pins the source-level fix.

**Docs**

- README rewritten to match the project's voice (lowercase headings, "built solo on weekends" framing) and to actually represent what claude-rpc is. Adds an inline card-poster preview, surfaces privacy as a first-class section instead of a single row, drops the drift-prone configuration-reference + template-variables tables in favour of pointers to `src/default-config.js` and `claude-rpc vars`. The five generated example cards in `site/examples/` are linked from the README so the reader sees what `claude-rpc card` actually produces.

## [0.6.0] - 2026-05-23

Polish pass. Install once, never think about it again.

**Highlights**

- Default Discord clientId ships working. `setup` test-fires a real `SessionStart` hook through the same launcher Claude Code uses and prints `hook pipe ✓ …` on success — a broken hook command can't hide until the next session.
- `claude-rpc` with no args is now a one-screen overview (daemon state, today/streak, four most useful next-step commands). Full help moved to `--help`.
- `--version` / `-V` / `-v` print `claude-rpc <version>`, sourced from `package.json` with a baked fallback for SEA builds.
- `claude-rpc upgrade-config` exposes the idempotent config migration directly.
- Unknown commands exit 1 with a hint to `--help` (was silently exit 0 with the help dump).
- Every failure surface (`backfill`, `badge`, `card`, unknown command, missing aggregate) prints a `↳` hint pointing at the next step — usually `claude-rpc doctor`.
- Exit codes documented in `--help`: 0 ok / 1 user error / 2 system error / 3 wrong state.

**Resilience**

- Bad / missing `config.json` no longer hard-exits the daemon. Parse errors log one line and fall back to baked defaults — a mid-edit save from the Electron GUI can't brick anything.
- Discord reconnect uses exponential backoff (5s → 10s → 20s → … cap 5min) with ±30% jitter, resetting to base on a successful connect. The old fixed 10s loop pounded the IPC socket forever when Discord was closed.
- `daemon.log` rotates at 5MB to `daemon.log.1` — same policy `events.jsonl` already used.
- A 30s mtime-poll fallback alongside `fs.watch` catches state/aggregate changes when Windows drops watcher events on atomic-rename writes.

**Internals**

- `loadConfig` deep-merges the user's `config.json` over `DEFAULT_CONFIG` (objects merge, arrays replace) — user file can be `{ "clientId": "..." }` and everything else picks up shipped defaults.
- `config.example.json` trimmed to a comment + clientId.
- `pricingKeyFor` anchored on the explicit `opus`/`sonnet`/`haiku` token between dashes instead of `String.includes`. A hypothetical `claude-sonneteer-x` model id no longer silently routes to sonnet pricing via a substring match; dated `-YYYYMMDD` suffixes are ignored.
- `src/ui.js` centralises the SYM_OK/SYM_FAIL/SYM_WARN/SYM_INFO + colour table that `doctor.js` already had; `cli.js` and `doctor.js` now share it.
- Image-precedence cascade (statusAssets → modelAssets → presence.largeImageKey) documented in one place at the resolution site.
- `card` poster's tape sticker reads the current version instead of the hardcoded `v0.4`.
- Every empty `catch {}` in `src/` carries a one-line justification comment (no silent failures without intent).
- `src/server/page.js` (1,277 LOC, four sibling string blocks) gained a TOC at the top and §1–§4 section markers.

**README**

- Rewritten. First 200 words are what / who / install. One install path leads (Windows portable exe — 4 lines to working presence); other platforms and "use your own Discord app" moved to `<details>`. Drift-prone "What's new in v0.2.0" callout removed. Command table reconciled — added `doctor`, `card`, `backfill`, `private`/`public`/`privacy`, `upgrade-config`. Troubleshooting leads with `claude-rpc doctor`.

**Tests**

- 81 → 134 tests. New coverage for `format.humanModel / humanTool / humanProject / fmtNum / fmtDuration / fmtHours / plural`, `languages.languageOf`, `insights.generateInsights`, `scanner.dayKey / weekKey / hourKey`, `state.readState / writeState / updateState / resetState`, `server/api.windowedAggregate / rangeToDays`, `server/page.buildHtml`, and a live route-walker over the dashboard. Every public `src/*.js` export is exercised at least once.
