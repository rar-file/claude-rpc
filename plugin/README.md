# claude-rpc plugin

A one-line way to get [**claude-rpc**](https://github.com/rar-file/claude-rpc) —
Discord Rich Presence for Claude Code — installed and running.

This plugin is a **thin bootstrapper**. It does not reimplement claude-rpc; on
its first session it simply runs the project's own documented installer:

```sh
npx claude-rpc@latest setup
```

That single command installs `claude-rpc` globally, wires the lifecycle hooks
into Claude Code, starts the daemon, and registers login autostart — so the end
state is identical to installing claude-rpc by hand. After it runs once,
claude-rpc's own hooks take over and the plugin stays out of the way.

## Install

```text
/plugin marketplace add rar-file/claude-rpc
/plugin install claude-rpc@claude-rpc
```

Then start (or restart) a Claude Code session. The Discord card appears within a
second or two of the first session after install. Check `claude-rpc doctor` if
anything looks off.

## How it works

- The plugin ships a single `SessionStart` hook → `bin/bootstrap.sh`.
- The script runs `npx claude-rpc@latest setup` **once**, in the background, and
  records a sentinel in the plugin's persistent data dir so later sessions
  no-op instantly.
- If claude-rpc is already set up (its hooks are in `~/.claude/settings.json`),
  there is nothing to do. If `claude-rpc` is installed but was never set up
  (for example `npm i -g claude-rpc` or Homebrew on their own), the script runs
  that install's `claude-rpc setup` instead of fetching another copy.
- It locates `node`/`npx` even under nvm/fnm/volta/asdf, where the hook shell's
  PATH can be minimal.

## Scope & uninstall

- **Platforms:** macOS / Linux / WSL (where `npx … setup` is the documented
  install). On native Windows, install the portable `.exe` from the
  [releases page](https://github.com/rar-file/claude-rpc/releases/latest)
  instead. There the script exits straight away with a one-line note
  (it detects Git Bash, MSYS2 and Cygwin with `uname -s`).
- **Removing it:** disabling/uninstalling the plugin stops the bootstrapper but
  does **not** remove claude-rpc itself (it's a real global install by then).
  To fully remove claude-rpc, run `claude-rpc uninstall`.

Everything `setup` does is reversible and documented in the project's
[`SECURITY.md`](https://github.com/rar-file/claude-rpc/blob/main/SECURITY.md).
