# Changelog

All notable changes to claude-rpc. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

- One-screen overview when invoked with no args (status, today, streak, four next-step commands) instead of the full help dump. `--help` / `-h` still shows everything.
- `--version` / `-V` / `-v` print `claude-rpc <version>`. Version sourced from `package.json` via new `src/version.js` (with a BAKED fallback for SEA exes).
- `card` poster's tape sticker reads the current version instead of the hardcoded `v0.4`.
- `CHANGELOG.md` added; `NOTES.md` gitignored.

