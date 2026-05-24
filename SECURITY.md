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
| Outbound network | `src/community.js`, `src/gist.js`, `default-config.js` asset URLs | Anonymous counters + (opt-in) gist publish + GIF assets | Telemetry: `community off`. Gist: only on explicit `badge --gist`. |
| Local subprocess | `reg.exe`, `git`, `gh` | Static args, no shell interpolation of untrusted input | n/a |

No credential access, no filesystem scanning outside `~/.claude-rpc` and Claude
Code transcripts, no keylogging, no clipboard access, no AV/EDR evasion.

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

`setup` adds command hooks to Claude Code's `settings.json` for eight lifecycle
events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`Stop`, `SubagentStop`, `Notification`, `SessionEnd`. Each entry looks like:

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

There are three distinct network behaviors. Two are optional; one is cosmetic.

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

### 3c. Presence GIF assets — Discord-side only

`default-config.js` references `https://cdn.qualit.ly/clawd-*.gif`. These URLs
are handed to Discord as image keys; **Discord's** client fetches them to render
the card. The daemon itself doesn't download them. Swap them for your own URLs
in `config.json` if you prefer.

## 4. Local subprocesses

All `child_process` use is static-argument and visible:

- `reg.exe add/delete` — the Run key above (`src/install.js`).
- `git` — read last commit subject / branch for the "just shipped" card
  (`src/git.js`).
- `gh repo view --json isPrivate` — auto-hide GitHub-private repos from the card
  (`src/privacy.js`); 1.5s timeout, silent skip if `gh` is absent.
- `gh gist` — only under 3b above.

No subprocess interpolates untrusted/remote input into a shell. The one
`shell: true` call (`verifyHookPipe`) uses only static, trusted args and is
documented inline as such.

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
