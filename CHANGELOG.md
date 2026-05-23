# Changelog

All notable changes to claude-rpc. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- Config defaults are baked into the binary. `loadConfig` deep-merges the user's `config.json` over `DEFAULT_CONFIG` (objects merge, arrays replace), so a user file can be `{ "clientId": "..." }` and everything else picks up shipped defaults.
- Bad or missing `config.json` no longer hard-exits the daemon. Parse failures, missing files, and non-object JSON now log one line and fall back to defaults. Mid-edit saves from the Electron GUI can't brick the daemon anymore.
- `config.example.json` trimmed to a comment + clientId.
- Image-precedence cascade (statusAssets → modelAssets → presence.largeImageKey) documented in one place at the resolution site in `src/daemon.js`.
- One-screen overview when invoked with no args (status, today, streak, four next-step commands) instead of the full help dump. `--help` / `-h` still shows everything.
- `--version` / `-V` / `-v` print `claude-rpc <version>`. Version sourced from `package.json` via new `src/version.js` (with a BAKED fallback for SEA exes).
- `card` poster's tape sticker reads the current version instead of the hardcoded `v0.4`.
- `CHANGELOG.md` added; `NOTES.md` gitignored.

