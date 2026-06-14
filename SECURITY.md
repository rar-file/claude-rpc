# Security & behavior disclosure

claude-rpc is a Discord Rich Presence daemon for Claude Code. To do its job it
has to (a) register itself to start on login and (b) wire commands into Claude
Code's hook system. Both are legitimate, documented behaviors — but they are
also patterns that automated supply-chain scanners (e.g. Socket.dev) flag,
because malware persists and injects the same way. This document is the
audit trail: every sensitive thing the package does, where in the source it
lives, why it's there, its blast radius, and how to reverse or disable it.

Everything below is verifiable against the published source — there is no
minified bundle, no obfuscation, no `eval`/`new Function`, and no remote code
fetch-and-execute anywhere in `src/`.

## TL;DR for reviewers

| Behavior | Where | Scope | Reversible? |
| --- | --- | --- | --- |
| Startup persistence | `src/install.js` → `addStartupEntry` | `HKCU` Run key, current user, no admin | Yes — `claude-rpc uninstall` / `removeStartupEntry` |
| Hook injection | `src/install.js` → `installHooks` | Only into Claude Code's own `settings.json`, only our own commands | Yes — `uninstallHooks` removes exactly what it added |
| Outbound network | `src/community.js`, `src/gist.js`, `src/usage.js`, `src/notify.js`, `default-config.js` | Anonymous counters + (opt-in) profile/gist/webhook + own read-only OAuth-usage poll + GIF assets | Telemetry: `community off`. Profile: `profile off`. Gist/webhook: opt-in only. Usage: `usage.enabled:false`. |
| Local subprocess | `reg.exe`, `wscript`, `git`, `gh`, `npm`, `claude`, `security`, notifiers | Static or escaped args, no shell interpolation of untrusted input | n/a |

No credential access beyond the read-only Claude Code OAuth-token read for usage
polling (§3d), no filesystem scanning outside `~/.claude-rpc` and Claude Code
transcripts, no keylogging, no clipboard access, no AV/EDR evasion.

## 1. Startup persistence (Windows Run key)

**Source:** `src/install.js`, `addStartupEntry` / `removeStartupEntry`.

On Windows, `setup` writes one value:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  ClaudeRPC = "<path-to-exe>" daemon
```

- **Why:** the Discord presence is driven by a long-lived daemon. If it doesn't
  restart on login, your presence silently stops working after every reboot.
- **Scope:** `HKCU` (current user) only. No admin elevation, no `HKLM`, no
  service install, no scheduled task.
- **Reverse it:** `claude-rpc uninstall` deletes the value. You can also delete
  it by hand in `regedit` or with
  `reg delete "HKCU\...\Run" /v ClaudeRPC /f`.
- The value points at the canonical install path (`%LOCALAPPDATA%`-class dir),
  not at wherever you happened to run the installer from — see
  `ensureCanonicalExe`.

Non-Windows platforms get **no** persistence registration (`install()` warns
and skips it).

## 2. Hook injection into Claude Code

**Source:** `src/install.js`, `installHooks` / `uninstallHooks`.

`setup` adds command hooks to Claude Code's `settings.json` for nine lifecycle
events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Stop`, `SubagentStop`, `Notification`, `SessionEnd`, `PreCompact`. Each entry looks like:

```jsonc
{ "matcher": "", "hooks": [{ "type": "command", "command": "\"<exe>\" hook PostToolUse" }] }
```

- **Why:** this *is* the integration. Claude Code's hook system is the
  supported, documented way for a tool to observe session lifecycle. The hook
  reads the event JSON on stdin, updates `~/.claude-rpc/state.json`, and prints
  `{"continue":true}`. It never blocks, rewrites, or vetoes a tool call — see
  `src/hook.js`, `processHookEvent`.
- **What the hook reads:** tool name, file path of the active tool, token usage
  counters, and `git push`/`git commit` detection (for the "just shipped"
  card). It writes only to local state/log files. It does not read file
  *contents*, prompts, or responses beyond the usage counters Claude provides.
- **Scope:** the installer only ever touches entries whose command matches
  `isOurHookCommand` (contains `claude-rpc` or `hook.js`). It will not modify,
  reorder, or delete anyone else's hooks.
- **Reverse it:** `claude-rpc uninstall` (or `uninstallHooks`) strips exactly
  the entries it added and leaves the rest of `settings.json` intact.

## 3. Outbound network

There are six distinct network behaviors: community totals (3a), gist
publishing (3b), squads/web login (3c), subscription-usage polling (3d),
the cosmetic GIF assets (3e), and the opt-in status webhook (3f). Each is
independently optional. The separate desktop dashboard app, if installed,
additionally auto-updates itself (3g).

### 3a. Community totals (telemetry) — ON by default for fresh installs

**Source:** `src/community.js`; endpoint in `src/default-config.js`
(`community.endpoint`); receiving end is the full Worker source in
[`worker/src/index.js`](worker/src/index.js).

A fresh install mints an anonymous UUID v4 and the daemon POSTs to
`https://claude-rpc-totals.claude-rpc.workers.dev/report` every 30 minutes.
The **complete** payload (see `buildPayload`, enforced by the Worker's
`validateReport`) is:

```json
{
  "instanceId": "<random UUID v4>",
  "sessionsDelta": 3,
  "tokensDelta": 142000,
  "version": "0.7.3",
  "osFamily": "win32",
  "ts": 1716500000000
}
```

What is **not** sent, ever: prompts, responses, file paths, file contents,
project/repo names, models, cost figures, usernames, hostnames, IP (beyond what
any HTTP request inherently exposes to Cloudflare's edge), or absolute counter
values — only forward deltas since the last accepted report.

- **Opt out any time:** `claude-rpc community off`.
- **Upgraders are protected:** anyone upgrading from a pre-v0.7 config is
  written `community.enabled: false`; re-enabling requires the explicit consent
  flow `claude-rpc community on`, which prints the payload schema first.
- **Why on by default:** the live badges in the README aggregate these counters.
  The trade-off is disclosed here, in the README, and at install time.
- **Auditable:** the Worker persists only two running integers and a 30-day
  `seen:<instanceId>` dedup marker. The source is in this repo.

### 3b. Gist badge publishing — only on explicit command

**Source:** `src/gist.js`. Runs **only** when you run `claude-rpc badge --gist`.
Publishes a badge SVG to *your own* GitHub gist via the `gh` CLI or a
`GH_TOKEN` you supply with `gist` scope. Hits `api.github.com` /
`gist.github.com`. Never runs unattended, never on install, never from the
daemon.

### 3c. Squads & web login — opt-in, profile-derived

**Source:** `worker/src/index.js` (+ `worker/src/auth.js`), `src/cli.js`
(`squad` command), `site/squad.html`. Squads are private mini-leaderboards
that regroup stats you **already publish** via the opt-in profile — joining
one sends nothing new from your machine; the worker derives weekly standings
from the same clamped lifetime totals the public board uses.

"Log in with GitHub" on the website is plain OAuth (no scopes — public
identity only; we never see email or repos). Sessions are stateless signed
tokens holding **only your public GitHub login**, stored in your browser's
localStorage and expiring after 7 days. The browser never receives an
`instanceId` — that remains the CLI's local credential; the worker resolves
GitHub login → profile via the link your own gist verification created.
Worker-side storage adds: `gh:<login>` → profile link, `squad:*` membership
records, and weekly baseline snapshots (auto-expiring). Leaving your last
squad deletes its record.

When the opt-in public profile is enabled (`profile on` + a handle), the daemon
also POSTs to `<endpoint>/profile` on the same 30-minute timer. Unlike the
anonymous 3a report, this one carries your chosen public identity. The
**complete** payload (`buildProfilePayload`, enforced by the worker's
`validateProfile`) is:

```json
{
  "instanceId": "<your local UUID>",
  "handle": "ada",
  "displayName": "Ada L.",
  "githubUser": "ada",
  "tokens": 142000000,
  "sessions": 1200,
  "activeMs": 360000000,
  "streak": 23,
  "version": "0.16.2",
  "osFamily": "linux",
  "ts": 1716500000000
}
```

It sends absolute totals (not deltas) and is idempotent worker-side (a SET, not
an add). `profile off` stops it.

### 3d. Subscription usage — your own token, to its issuer, ON by default

**Source:** `src/usage.js`; consumed by the daemon poll, `claude-rpc usage`,
and the `{usageWeeklyPct}`-family template variables.

The daemon reads the OAuth access token Claude Code already stores on your
machine (`~/.claude/.credentials.json`; the login keychain on macOS) and calls
`GET https://api.anthropic.com/api/oauth/usage` — the same internal endpoint
Claude Code's own `/usage` screen uses — every 10 minutes **while a session is
live**. The response (session %, weekly %, reset times) is cached in
`$TMPDIR/claude-rpc/usage.json`.

The trust boundary is deliberately narrow:

- The token is sent **only to `api.anthropic.com` — the party that issued
  it**. It is never logged, never written anywhere new, and never sent to the
  claude-rpc worker or any other host. Only the daemon and the one-shot
  `claude-rpc usage` command touch credentials; every other surface reads the
  percentage cache.
- **Read-only:** the refresh token is never used or modified. If the access
  token expires, polling goes quiet until Claude Code itself refreshes it.
- The percentages stay local unless **you** template them into your Discord
  card (a default rotation frame does, and disappears whenever data is
  missing or stale).
- Installs without OAuth credentials (API key, enterprise gateways) are
  silently skipped — there is nothing to fetch.
- **Off switch:** `usage.enabled: false` in `config.json` stops the polling,
  the command's live fetch, and the card frame in one go.

### 3e. Presence GIF assets — Discord-side only

`default-config.js` references `https://cdn.qualit.ly/clawd-*.gif`. These URLs
are handed to Discord as image keys; **Discord's** client fetches them to render
the card. The daemon itself doesn't download them. Swap them for your own URLs
in `config.json` if you prefer.

### 3f. Status webhook — opt-in, OFF by default

**Source:** `src/notify.js` (`postWebhook`), fired from the daemon's
`fireStatusSideEffects` (`src/daemon.js`). Dormant unless you set `webhook.url`
and list statuses in `webhook.on`. On a matching status transition the daemon
POSTs to your configured URL (a Slack/Discord channel or your own endpoint):

```json
{ "status": "notification", "project": "my-app", "model": "claude-opus-4-8", "justShipped": null, "ts": 1716500000000 }
```

`project` is the cwd-derived name — redacted to `"Claude Code"` when the
directory is privacy=hidden, and run through `sanitizeLabel` (strips shell /
PowerShell metacharacters) first; `model` is always sent. The webhook is
suppressed entirely while the card is paused or privacy=hidden. Turn it off by
removing `webhook.url`.

### 3g. Desktop dashboard auto-update — the optional Electron app only

**Source:** `dashboard/main.js` (`initAutoUpdater`, electron-updater). The npm
CLI package never auto-updates. The *separate* desktop dashboard app, if you
install it, polls GitHub Releases hourly and downloads + installs updates on
quit (`autoDownload` / `autoInstallOnAppQuit`) over HTTPS. The release binaries
are currently **unsigned**, so update integrity rests on GitHub Releases + TLS
rather than a code signature — a known gap tracked for provenance + published
checksums. Avoid it by not installing the dashboard.

## 4. Local subprocesses

Every binary the package can spawn, with its trigger and argument shape. All
arguments are static constants or values we control — none interpolate
untrusted or remote input into a shell:

- `reg.exe add/delete` — the Windows Run key (`src/install.js`).
- `wscript.exe` — runs the generated windowless startup shim (`src/install.js`).
- `chcp.com 65001` — set the console to UTF-8 on Windows TTYs (`src/cli.js`).
- `git` — read last commit subject / branch for the "just shipped" card
  (`src/git.js`).
- `gh repo view --json isPrivate` — auto-hide GitHub-private repos from the card
  (`src/privacy.js`); 1.5s timeout, silent skip if `gh` is absent.
- `gh gist` / `gh --version` — gist badge publishing, only under 3b
  (`src/gist.js`).
- `npm root -g` / `npm install -g` — resolve / promote the global install during
  `setup` (`src/install.js`, `src/cli.js`).
- `claude mcp add/remove` — register / unregister the MCP server on
  `mcp install` / `mcp uninstall` (`src/install.js`).
- `security find-generic-password` — read Claude Code's OAuth token from the
  macOS login keychain for usage polling (`src/usage.js`, §3d). Read-only; may
  prompt for keychain access.
- `osascript` / `powershell` / `notify-send` — the opt-in desktop notification
  (`src/notify.js`); off unless `notify.enabled`. The project label is
  interpolated but sanitized first (`sanitizeLabel`).

No subprocess passes untrusted or remote input to a shell — arguments are
static or escaped. The historical `shell: true` paths (`verifyHookPipe`, and the
gist `gh` wrapper on Windows) use only trusted args.

## 5. What it stores locally

Under `~/.claude-rpc/` (a.k.a. `%APPDATA%\claude-rpc\` on Windows):
`config.json`, `state.json`, `aggregate.json`, `events.jsonl` (rotated at 5 MB),
`private-list.json`, `community-cursor.json`. The scanner also reads Claude Code
transcript files to build aggregates. None of this leaves your machine except
the minimal telemetry in 3a.

## 6. Privacy controls

Independent of telemetry, the Discord card has a privacy valve (`src/privacy.js`):
per-project `.claude-rpc.json`, a runtime private-list, config glob patterns, and
`gh`-based auto-hide of private repos. Levels: `public` / `name-only` / `hidden`.
Local dashboards and aggregates are never redacted — privacy is a one-way valve
from local state to Discord only.

## Reporting a vulnerability

Open an issue at https://github.com/rar-file/claude-rpc/issues, or for anything
sensitive email c.archer.simmons@gmail.com. Please include version
(`claude-rpc --version`), OS, and repro steps.
