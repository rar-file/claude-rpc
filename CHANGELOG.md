# Changelog

All notable changes to claude-rpc. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

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
