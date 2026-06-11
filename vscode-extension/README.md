# Claude RPC — Claude Code Status for VS Code

Live [Claude Code](https://claude.com/claude-code) status in your status bar, driven by [claude-rpc](https://github.com/rar-file/claude-rpc)'s state files.

**Tracks Claude Code only.** Unlike editor-presence extensions, this never reports what *you* are editing — it mirrors what *Claude* is doing, and it has no network surface (the only request it ever makes is an optional probe of your own `localhost` dashboard).

## What you get

- **Status bar item** — `Working · my-app · 1.2M tok`, `Thinking`, `Needs you` (highlighted — a permission prompt is waiting), `Shipped` after a push, `Idle`, `Away`.
- **Hover** — model, session duration, prompts/tool calls, token breakdown, today's hours, all-time totals, streak.
- **Pause / resume the Discord card** from the editor (writes the same `pause.json` marker as `claude-rpc pause`).
- **Open the local dashboard**, with a one-click offer to start the server if it isn't running.
- Click the item for the menu.

## Requirements

[claude-rpc](https://github.com/rar-file/claude-rpc) set up (`npx claude-rpc setup`) so Claude Code's hooks write the state files this extension reads:

- `<tmpdir>/claude-rpc/state.json` — live session state (written by the hooks; works even with the Discord daemon stopped)
- `~/.claude-rpc/aggregate.json` — lifetime stats (written by the scanner)

In remote / WSL setups the extension runs where Claude Code runs (`extensionKind: workspace`), so the files are always local to it.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeRpc.hideWhenStale` | `false` | Hide the item entirely when Claude Code isn't running |
| `claudeRpc.showTokens` | `true` | Append the session token count to the label |
| `claudeRpc.pollIntervalSec` | `3` | Fallback re-read cadence (watchers cover most changes) |

## Build from source

```sh
cd vscode-extension
npm run package        # → claude-rpc-vscode-<version>.vsix
code --install-extension claude-rpc-vscode-*.vsix
```

Zero dependencies, plain CommonJS — nothing to compile.
