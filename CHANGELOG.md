# Changelog

All notable changes to claude-rpc. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

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

