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

The test suite uses the built-in Node test runner (`node --test test/*.test.js`),
has zero runtime/test dependencies beyond the package itself, runs ~267 tests,
and finishes in about 2 seconds. If `npm test` is green, you have a working
checkout.

> Requires Node 18+ (the project is ESM, `"type": "module"`). It is developed on
> recent Node and CI runs against the supported range.

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
npm run lint          # eslint over src + test
npm run format        # prettier --write
npm run format:check  # prettier in CI/check mode
npm run typecheck     # opt-in; see "Type checking" below
```

### Type checking (opt-in)

The codebase is plain JavaScript with JSDoc annotations on the most important
public functions. `jsconfig.json` ships with `checkJs: false` on purpose:
turning it on across the whole tree produces a flood of `any`/implicit-type
noise that isn't worth chasing for a project this size. `npm run typecheck`
(`tsc --noEmit`) is available as an opt-in aid if you're adding types to a
file you're working on — it is not enforced in CI.

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

Releases are **tag-driven**. Pushing a version tag triggers
`.github/workflows/release.yml`, which builds and publishes. You don't need to
run a publish command by hand — bumping the version, tagging, and pushing the
tag is the flow.

## Sub-project versioning

This repo holds more than the npm package:

- The **root** package (`claude-rpc`) is the thing published to npm.
- `worker/` (the Cloudflare Worker) and `dashboard/` (the Electron app) are
  **versioned independently** and are **not published to npm**. Their version
  numbers don't have to track the root package, and changes there don't require
  a root release.

So a change confined to `worker/` or `dashboard/` follows its own version
bump and deploy/build path, separate from the npm release flow above.

## License

By contributing you agree your contributions are licensed under the project's
[MIT License](LICENSE).
