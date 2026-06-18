# Versioning & stability policy

claude-rpc follows [Semantic Versioning](https://semver.org). This document is
the contract that semver applies to: it names what is **stable** (changes only
on a major bump, with deprecation notice) and what is **internal** (may change
in any release, including a patch).

If you build on something in the "stable" list, an `npm update` within a major
version will not break you. If you depend on something in the "internal" list,
you are coupling to an implementation detail and it may move without warning.

> **What 1.0.0 means.** The surfaces below have been stable in practice for many
> releases; 1.0.0 is the point at which that stability becomes a *promise*. It is
> not a feature event — it is a compatibility commitment.

---

## Stable — governed by semver

A breaking change to anything here requires a **major** version bump and a
deprecation path (see [Deprecation policy](#deprecation-policy)).

### 1. Worker HTTP API

The Cloudflare Worker's public HTTP surface — documented in full in
[`docs/WORKER-API.md`](docs/WORKER-API.md). People embed these in READMEs and
dashboards, so the rule is **additive only**:

- Every existing **path** stays at its current location and method:
  `/badge/<handle>.svg`, `/card/<handle>.svg`, `/sessions.svg`, `/tokens.svg`,
  `/total.json`, `/profile`, `/leaderboard`, `/squad`, `/squad/bycode`,
  `/refs.json`, `/ref`, `/health`, `/auth/*`, and the POST routes
  (`/report`, `/profile`, `/verify/*`, `/pair/*`, `/squad/*`, `/squads/mine`).
- Existing **query params** keep their names and meaning
  (`?metric=`, `?label=`, `?handle=`, `?limit=`, `?id=`, `?code=`, `?s=`).
- Existing **response fields** keep their names, types, and meaning. New fields
  may be added; the top-level `schemaVersion` marks the JSON shape.
- The `?metric=` value set for badges/leaderboard
  (`tokens` · `sessions` · `hours`/`activems` · `streak`) is stable.

The `*.svg` routes always return an SVG (a neutral placeholder for unknown
input) so an embedded `<img>` never breaks.

### 2. CLI — commands, flags, exit codes

Command names (and their aliases) are stable; none are renamed or removed within
a major version. The full set:

`start` · `stop` · `restart` · `daemon` · `setup` (alias `install`) ·
`uninstall` · `upgrade-config` · `status` (`--dump`) · `today` · `week` ·
`usage` · `preview` · `scan` · `rescan` · `backfill <dir>` ·
`export` (`--csv`, `--out`) · `insights` · `vars` ·
`badge` · `card` · `github-stat` · `statusline` · `calendar` · `session-card` ·
`readme` · `mcp` (+ `mcp install` / `mcp uninstall`) · `serve` · `wrapped` ·
`pause [dur]` · `resume` (alias `unpause`) ·
`private` · `public` · `privacy` ·
`community` (`on`/`off`/`status`/`report`) ·
`profile` (`status`/`set`/`on`/`off`/`publish`/`verify`) ·
`squad` (`create`/`join`/`leave`/`status`) · `link [code]` ·
`doctor` (`--fix`) · `tail` (aliases `log`, `logs`) ·
`--version`/`-V`/`-v` · `--help`/`-h`/`help`.

Documented per-command flags (e.g. `badge --metric/--range/--out/--gist/--label`,
`card --range`, `github-stat --handle/--out/--gist`, `statusline --template`,
`calendar --out/--gist`, `export --csv/--out`, `doctor --fix`) keep their names
and short forms. New flags and new commands may be added.

**Exit codes** are part of the contract (defined in [`src/ui.js`](src/ui.js)):

| Code | Name | Meaning |
| ---- | ---- | ------- |
| `0` | `EX_OK` | success |
| `1` | `EX_USER_ERROR` | bad input / wrong usage / unknown command |
| `2` | `EX_SYS_ERROR` | system or external-service failure (network, unexpected error) |
| `3` | `EX_BAD_STATE` | the command can't run in the current state (e.g. no aggregate yet, community not enabled) |

### 3. `config.json` schema and back-compat

The user config schema — every key in [`src/default-config.js`](src/default-config.js)
— is stable, and **old configs keep working**. Concretely:

- Every key has a baked default, so a config only needs to hold *overrides*.
  `{ "clientId": "..." }` is a complete, valid config.
- The loader deep-merges user config over the defaults: **plain objects merge,
  arrays replace** (your `rotation` array is yours, never spliced with defaults).
  See [`src/config.js`](src/config.js).
- Loading **never throws**: bad JSON, a missing file, or a non-object config logs
  one line and falls back to baked defaults.
- On every setup/upgrade, `migrateConfig` non-destructively adds any missing
  keys/blocks and refreshes shipped-default values you haven't customized; on
  daemon start, `selfHealOnUpdate` runs the same migration when the version
  changes. Both are **idempotent** and only write when something actually
  changed. See [Config migration guarantee](#config-migration-guarantee).

Config lives outside the install tree so it survives `npm update`:
`%APPDATA%\claude-rpc\config.json` (Windows) ·
`~/Library/Application Support/claude-rpc/config.json` (macOS) ·
`$XDG_CONFIG_HOME/claude-rpc/config.json` (Linux).

### 4. Template variables

The presence/statusline template variables — the `{name}` tokens you put in
`config.json` frames and `statusline --template`. The authoritative, always-current
list is **`claude-rpc vars`** (currently ~215 variables). Variable *names* and
their meaning are stable; new variables may be added. A frame's `requires`
mechanism (skip a frame when a required variable is empty/zero) is also stable.

### 5. Local data formats

These files are human-readable JSON you can `cat`/`jq`, and their shapes are
stable for downstream tooling:

- **`~/.claude-rpc/aggregate.json`** — all-time aggregates. Carries a `_v`
  schema-version field (currently `4`); top-level keys (`activeMs`, `sessions`,
  `streak`, `byDay`, `byHour`, `topEditedFiles`, `languages`, `estimatedCost`,
  `modelSplit`, …) are stable and additive. The `_v` bump signals a shape change
  the scanner handles by re-deriving.
- **`claude-rpc export`** — emits the aggregate as JSON (default) or the per-day
  rows as CSV (`--csv`). Same shapes the dashboard's `/api/export` routes serve.
- **`GET /total.json`** — the worker's community feed (see API reference).

### 6. Telemetry payload

The anonymous community report is a privacy contract, documented byte-for-byte in
[`SECURITY.md`](SECURITY.md): a `sessionsDelta`, a `tokensDelta`, the claude-rpc
`version`, `osFamily` (`linux`/`darwin`/`win32`), and an anonymous UUID v4. The
worker's [`validateReport`](worker/src/index.js) is the schema of record. Nothing
is *added* to this payload without a documented change; `claude-rpc community off`
ends it entirely.

---

## Internal — not a contract

These are implementation details. They may change in **any** release, including a
patch. Do not build on them.

- **Daemon internals.** Frame-resolution precedence (stale > shipped > trigger >
  base), the activity-throttle hashing, reconnect backoff/jitter, liveness
  deadlines, idle/stale timing, and subagent accounting. Watch
  [`src/daemon.js`](src/daemon.js) / [`src/format.js`](src/format.js) behavior,
  not their internals.
- **Scanner cache.** `~/.claude-rpc/scan-cache.json` is a private incremental-parse
  cache with its own `_v` (`CACHE_VERSION`); it is rebuilt whenever the version or
  shape changes. Not for external consumption.
- **Worker KV layout.** Every KV key the worker writes (`total:counters`,
  `pf:<id>`, `handle:<h>`, `board:index`, `alias:<id>`, `gh:<login>`, `squad:*`,
  `sqcode:*`, `sqmember:*`, `sqbase:*`, `verify:*`, `pair:*`, `seen:*`, `rate:*`,
  `ref:*`) is internal. Consume the HTTP API, never the KV.
- **Volatile session state.** `$TMPDIR/claude-rpc/state.json`, `daemon.pid`,
  `daemon.log`, `pause.json`, `usage.json` — runtime scratch, cleared on reboot.
- **Exact wording & visuals.** Insight phrasing (`claude-rpc insights`), default
  rotation-frame copy, and the precise pixels of SVG cards/badges are content and
  presentation — they get refined freely. The *routes* and *variables* that drive
  them are stable; the strings they produce are not.
- **Bundled defaults that can rotate.** The bundled Discord `clientId`, the
  default asset/GIF URLs, and the default CTA button target. Override them in
  `config.json` if you need them pinned.
- **Diagnostic/event logs.** `~/.claude-rpc/events.jsonl` and `daemon.log` formats.

---

## Config migration guarantee

Upgrading claude-rpc never loses your config. Two functions in
[`src/install.js`](src/install.js) enforce this:

- **`migrateConfig()`** — runs on every `setup`/`upgrade-config`. Non-destructive:
  adds missing keys/blocks from the current defaults, refreshes only
  shipped-default values you haven't customized (e.g. a dead button URL, an old
  tooltip string), appends new default rotation frames *only* if your rotation is
  still default-derived, and seeds a pre-v0.7 config's community block as
  `enabled: false` (never silently opting an upgrader in). It writes only when
  something changed and returns whether it did.
- **`selfHealOnUpdate()`** — runs on daemon start. When the on-disk version stamp
  differs from the running version, it re-wires hooks, runs `migrateConfig()`,
  carries the login-autostart forward, and stamps the new version. Best-effort and
  never throws.

Both are **idempotent** — running them repeatedly is a no-op once current. The
invariants (arrays replace, unknown keys preserved, customizations untouched,
never throws) are pinned by [`test/install.test.js`](test/install.test.js) and
[`test/config.test.js`](test/config.test.js).

To migrate an old file by hand: `claude-rpc upgrade-config`.

---

## Deprecation policy

When a stable surface must change incompatibly:

1. The replacement ships first; the old form keeps working.
2. The old form is documented as deprecated (here, in `CHANGELOG.md`, and in
   `--help`/CLI output where it surfaces) for at least one minor release.
3. Removal happens only on a major version bump.

For the worker API specifically, removal of a path/param/field is a major event;
in practice the worker is **additive only** — new routes and fields appear, old
ones stay — because READMEs across the community embed the existing ones.

---

## See also

- [`docs/WORKER-API.md`](docs/WORKER-API.md) — full worker HTTP reference
- [`SECURITY.md`](SECURITY.md) — every sensitive behavior + the telemetry payload
- [`ROADMAP.md`](ROADMAP.md) — direction, and the deliberate "never" list
- `claude-rpc vars` — the authoritative template-variable list
