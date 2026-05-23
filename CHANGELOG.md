# Changelog

All notable changes to claude-rpc. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

_No changes yet._

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
