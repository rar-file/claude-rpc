#!/bin/sh
# claude-rpc plugin bootstrap
# -----------------------------------------------------------------------------
# Fired by this plugin's SessionStart hook. Makes sure claude-rpc is set up,
# once, in the background, then gets out of the way.
#
# `setup` is the whole install: it installs claude-rpc globally, wires its hooks
# into ~/.claude/settings.json, starts the daemon, and registers login
# autostart. After it has run once, claude-rpc's OWN hooks take over the
# self-heal, and this script no-ops on every later session.
#
#   - claude-rpc's hooks already in settings.json: nothing to do.
#   - claude-rpc on PATH but never set up (`npm i -g` or Homebrew alone):
#     run that install's `claude-rpc setup`.
#   - claude-rpc not installed: run the project's documented installer,
#     `npx claude-rpc@latest setup`.
#
# Scope: macOS / Linux / WSL -- the platforms where `npx ... setup` is the
# documented install. On native Windows (Git Bash, MSYS2, Cygwin) the script
# exits straight away: install the Windows app (.exe) instead (see the README).
# -----------------------------------------------------------------------------
set -u

case "$(uname -s 2>/dev/null)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    echo "claude-rpc plugin: skipped on native Windows. Install the Windows app instead: https://github.com/rar-file/claude-rpc/releases/latest" >&2
    exit 0
    ;;
esac

# Per-plugin persistent dir (survives plugin updates; created + exported to hook
# processes by Claude Code). Fall back to ~/.claude if it is somehow unset.
DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/claude-rpc-plugin}"
mkdir -p "$DATA" 2>/dev/null || true
SENTINEL="$DATA/bootstrapped"
LOG="$DATA/bootstrap.log"
LOCK="$DATA/.lock"
SETTINGS="$HOME/.claude/settings.json"

# setup tags every hook it writes with "_claudeRpc": true (src/install.js).
# Untagged hooks from old versions count as missing; setup re-tags them.
hooks_wired() { grep -q '"_claudeRpc"' "$SETTINGS" 2>/dev/null; }
mark_done() { echo ok > "$SENTINEL" 2>/dev/null || true; }

# Fast skip: setup already ran from here. The sentinel is kept even if the
# hooks are removed later (e.g. `claude-rpc uninstall`), so an uninstall sticks.
[ -s "$SENTINEL" ] && exit 0

# Already set up some other way (by hand, or by the desktop app).
if hooks_wired; then mark_done; exit 0; fi

# An EMPTY sentinel comes from an older version of this script. That version
# also wrote one, without wiring anything, whenever claude-rpc was already on
# PATH. Keep it only if its log shows a setup that succeeded. Otherwise set up now.
if [ -f "$SENTINEL" ]; then
  if grep -q '^bootstrap: ok' "$LOG" 2>/dev/null; then mark_done; exit 0; fi
  rm -f "$SENTINEL" 2>/dev/null || true
fi

# Installed but never set up: use that install rather than fetching another.
HAVE_CLI=0
command -v claude-rpc >/dev/null 2>&1 && HAVE_CLI=1

# Single-flight across concurrently-opening sessions. Steal a lock left behind
# by a crashed run (older than 10 min) so we can never deadlock permanently.
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -prune -mmin +10 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi

# Make node/npx reachable. Claude Code's hook shell can run with a minimal PATH
# that misses version-manager shims (nvm/fnm/volta/asdf), so probe the usual
# spots and prepend the first that actually has `npx`.
find_npx() {
  command -v npx >/dev/null 2>&1 && return 0
  for d in \
    "$HOME/.volta/bin" \
    "$HOME/.local/share/fnm/aliases/default/bin" \
    "$HOME/.asdf/shims" \
    /opt/homebrew/bin \
    /usr/local/bin \
    "$HOME/.local/bin"
  do
    [ -x "$d/npx" ] && { PATH="$d:$PATH"; export PATH; return 0; }
  done
  # nvm keeps every installed version here; pick the newest.
  nvm_root="${NVM_DIR:-$HOME/.nvm}/versions/node"
  if [ -d "$nvm_root" ]; then
    newest=$(ls -1 "$nvm_root" 2>/dev/null | sort -V | tail -n 1)
    if [ -n "$newest" ] && [ -x "$nvm_root/$newest/bin/npx" ]; then
      PATH="$nvm_root/$newest/bin:$PATH"; export PATH; return 0
    fi
  fi
  command -v npx >/dev/null 2>&1
}

run_setup() {
  if [ "$HAVE_CLI" = 1 ]; then
    echo "claude-rpc is installed but its hooks aren't wired: running claude-rpc setup"
    claude-rpc setup
  else
    npx -y claude-rpc@latest setup
  fi
}

# Do the real work detached so SessionStart returns immediately -- the first run
# can take a while as npx fetches the package. The sentinel is written only on
# success, so a failed attempt (e.g. offline) is retried next session.
{
  if [ "$HAVE_CLI" = 1 ] || find_npx; then
    {
      echo "--- $(date 2>/dev/null) claude-rpc plugin bootstrap ---"
      if run_setup; then
        mark_done
        echo "bootstrap: ok"
      else
        echo "bootstrap: setup failed (will retry next session)"
      fi
    } >>"$LOG" 2>&1
  else
    echo "$(date 2>/dev/null) bootstrap: no node/npx on PATH; skipping. Install Node 18+ or use the portable exe (see README)." >>"$LOG" 2>&1
  fi
  rmdir "$LOCK" 2>/dev/null || true
} >/dev/null 2>&1 </dev/null &

exit 0
