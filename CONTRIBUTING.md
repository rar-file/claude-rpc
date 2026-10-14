# Contributing to claude-rpc

Thanks for taking a look. `claude-rpc` is a solo project built on weekends, so
contributions, bug reports, and ideas are genuinely appreciated. The goal of
this doc is to get you from clone to passing tests in a couple of minutes.

## Getting started

```bash
git clone https://github.com/rar-file/claude-rpc.git
cd claude-rpc
npm install
npm test
```

`npm test` runs the built-in Node test runner over every `test/*.test.js`
file (via `scripts/run-tests.mjs`, which lists the files itself instead of
relying on a shell glob, so it works in PowerShell too). It has zero
runtime/test dependencies beyond the package itself, runs 550+ tests, and
finishes in a few seconds. If `npm test` is green, you have a working checkout.

The Cloudflare Worker has its own suite (also dependency-free at test time):

```bash
npm --prefix worker ci
npm --prefix worker test
```

> Requires Node 18+ (the project is ESM, `"type": "module"`). It is developed on
> recent Node; CI runs both suites on Node 18, 20, 22 and 24.

## Debugging locally

`claude-rpc doctor` is the fastest way to see what's wrong on a machine — it
checks for the daemon, the hook wiring, Discord IPC, config, and transcript
discovery, and prints a diagnosis. Run it first when something isn't lighting up:

```bash
claude-rpc doctor
```

## Code style

- **ESM only** — `import`/`export`, no CommonJS.
- **2-space indentation**, single quotes, semicolons, ~100 column print width.
- Keep the dependency surface tiny. claude-rpc ships with **zero runtime
  dependencies** (Discord IPC is hand-rolled in `src/discord-ipc.js`); please
  don't add any without a strong reason.
- Prefer small, pure, testable helpers — most of the logic in `src/` is
  unit-tested as plain functions, separate from any I/O or transport layer.

Tooling to keep things consistent:

```bash
npm run lint          # eslint over src + test + vscode-extension (CI-enforced)
npm run format        # prettier --write
npm run format:check  # prettier check mode — NOT run in CI (see below)
npm run typecheck     # tsc over src/ (CI-enforced; see "Type checking")
```

`format:check` is deliberately not a CI gate: the tree has never been
prettier-clean, and the one-off reformat is waiting to land as its own commit.
Formatting the files you touch is still appreciated.

### Type checking

The codebase is plain JavaScript with JSDoc annotations on the most important
public functions. `jsconfig.json` ships with `checkJs: false` on purpose:
turning it on across the whole tree produces a flood of `any`/implicit-type
noise that isn't worth chasing for a project this size. `npm run typecheck`
(`tsc -p jsconfig.json`, no emit) **does run in CI** (the `static` job in
`.github/workflows/ci.yml`), but with `checkJs` off it mostly catches syntax
errors, not type errors. To get real type checking for a file you're working
on, put `// @ts-check` at its top — from then on CI checks that file too.

## Tests

- Add or update tests for any behavior change. Tests live in `test/*.test.js`.
- Keep handlers/decision logic pure where possible so they can be tested
  without standing up the daemon, Discord IPC, or the MCP transport.
- Fixtures are defined inline in each test file (small, dependency-free).

## Submitting changes

1. Open an issue first for anything non-trivial so we can agree on the shape.
2. Branch, make your change, add tests, run `npm test` and `npm run lint`.
3. Add a `CHANGELOG.md` entry if the change is user-facing.
4. Open a PR. The PR template has a short checklist.

## Releases

Releases are **tag-driven**. Bump the version in `package.json`, add the
`CHANGELOG.md` entry, then push a `v<version>` tag: that triggers
`.github/workflows/release.yml`, which runs the test matrix, builds the CLI
binaries and the desktop installers on macOS and Windows, creates the GitHub
Release with them attached, and publishes to npm (after checking the tag
matches `package.json`). You don't run `npm publish` by hand.

Two steps are still **manual**:

- **Homebrew formula.** Once the npm publish has landed, run
  `node scripts/brew-formula.mjs` — it fetches the published tarball, writes
  its URL and sha256 into `homebrew/claude-rpc.rb` — and commit the result.
- **Worker deploy.** Nothing in CI deploys the Cloudflare Worker. After a
  change under `worker/`, deploy it with `npm --prefix worker run deploy`
  (`wrangler deploy`; see [`worker/README.md`](worker/README.md)).

## Sub-project versioning

This repo holds more than the npm package:

- The **root** package (`claude-rpc`) is the thing published to npm.
- `worker/` (the Cloudflare Worker) is **versioned independently**, is not
  published to npm, and ships by a manual `wrangler deploy` (above) — a
  worker-only change needs no root release.
- `dashboard/` (the Electron app) is not published to npm, but it is **not**
  versioned independently: `scripts/prep-dashboard.js` (run by `release.yml`
  and by `npm run dist:mac` / `dist:win`) overwrites `dashboard/package.json`'s
  version with the root version before electron-builder names the artifacts
  and writes the auto-update feed. The desktop app therefore ships with every
  root release, under the root version; the version committed in
  `dashboard/package.json` is only a placeholder.
- `vscode-extension/` is versioned independently and packaged by hand
  (`npm --prefix vscode-extension run package`).

## License

By contributing you agree your contributions are licensed under the project's
[MIT License](LICENSE).
