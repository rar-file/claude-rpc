# Changelog

All notable changes to claude-rpc. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Test suite up to 127 tests (was 81). New coverage for the public-export gaps the audit flagged: `format.humanModel / humanTool / humanProject / fmtNum / fmtDuration / fmtHours / plural`, `languages.languageOf`, `insights.generateInsights`, `scanner.dayKey / weekKey / hourKey`, `state.readState / writeState / updateState / resetState`, `server/api.windowedAggregate / rangeToDays`, and `server/page.buildHtml`. A live `node` child boots the dashboard and walks every documented route (`/api/state`, `/api/aggregate`, `/api/insights`, `/api/badge.svg`, `/api/card.svg`, `/`, `/api/day/:k`, 404) asserting status + content-type + JSON/SVG shape.
- `src/server/page.js` (1,277 LOC, four sibling string blocks) gained a TOC at the top and §1–§4 section markers so the CSS / lang palette / HTML / client-runtime blocks are findable without scrolling-by-hope. No code change.
- README rewritten. Drift-prone "What's new in v0.2.0" callout removed. One install path leads (Windows portable exe, 4 lines to working presence); other platforms and the "use your own Discord app" path moved to `<details>` blocks. The "Discord app setup" section is gone — a working public clientId ships in the default config. Command table reconciled against actual CLI exports (added `doctor`, `card`, `backfill`, `private`/`public`/`privacy`, `upgrade-config`, etc.). Troubleshooting section leads with `claude-rpc doctor`.
- `pricingKeyFor` now anchors on the explicit `opus`/`sonnet`/`haiku` token between dashes instead of `String.includes`. A hypothetical `claude-sonneteer-x` model id no longer silently routes to sonnet pricing via a substring match. Dated suffixes like `-20251101` are ignored. Three new regression tests pin the resolution table.
- Discord reconnect now uses exponential backoff (5s → 10s → 20s → … cap 5min) with ±30% jitter, and resets to the base on a successful connect. Old fixed 10s loop burnt cycles against a closed Discord client forever.
- `daemon.log` rotates at 5MB to `daemon.log.1` — same policy `events.jsonl` already used.
- Added a 30s mtime-poll fallback alongside `fs.watch` for `state.json` / `aggregate.json` so the daemon picks up changes even when Windows drops watcher events under the atomic-rename writer pattern.
- Every empty `catch {}` in `src/` now carries a one-line justification comment (no silent failures without intent).
- `setup` now test-fires a real `SessionStart` hook through the same launcher Claude Code will use, and prints `hook pipe ✓ …` when it round-trips. A broken hook command no longer hides until the next time the user opens Claude Code.
- `setup` ends with `Then: \`claude-rpc doctor\` to verify everything is wired.` — User B's 30-second path.
- `claude-rpc upgrade-config` exposes the idempotent `migrateConfig` migration directly, so existing users can pull in shape changes without re-running full `setup`.
- Unknown commands now exit 1 with a hint to `--help` instead of silently printing the help dump and exiting 0.
- Every failure surface points at the next step: backfill/badge/card error paths use a shared `fail(label, hint)` from new `src/ui.js`, defaulting the hint to `run \`claude-rpc doctor\``. Exit codes documented in `--help` (0 ok / 1 user / 2 system / 3 state).
- `src/ui.js` centralises the SYM_OK/SYM_FAIL/SYM_WARN/SYM_INFO + colour table that `doctor.js` already had; `cli.js` and `doctor.js` now share it. One ANSI table to maintain.
- Config defaults are baked into the binary. `loadConfig` deep-merges the user's `config.json` over `DEFAULT_CONFIG` (objects merge, arrays replace), so a user file can be `{ "clientId": "..." }` and everything else picks up shipped defaults.
- Bad or missing `config.json` no longer hard-exits the daemon. Parse failures, missing files, and non-object JSON now log one line and fall back to defaults. Mid-edit saves from the Electron GUI can't brick the daemon anymore.
- `config.example.json` trimmed to a comment + clientId.
- Image-precedence cascade (statusAssets → modelAssets → presence.largeImageKey) documented in one place at the resolution site in `src/daemon.js`.
- One-screen overview when invoked with no args (status, today, streak, four next-step commands) instead of the full help dump. `--help` / `-h` still shows everything.
- `--version` / `-V` / `-v` print `claude-rpc <version>`. Version sourced from `package.json` via new `src/version.js` (with a BAKED fallback for SEA exes).
- `card` poster's tape sticker reads the current version instead of the hardcoded `v0.4`.
- `CHANGELOG.md` added; `NOTES.md` gitignored.

