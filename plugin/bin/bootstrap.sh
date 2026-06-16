#!/bin/sh
# claude-rpc plugin bootstrap
# -----------------------------------------------------------------------------
# Fired by this plugin's SessionStart hook. Runs the project's own documented
# installer -- `npx claude-rpc@latest setup` -- exactly once, in the background,
# then gets out of the way.
#
# `setup` is the whole install: it installs claude-rpc globally, wires its hooks
# into ~/.claude/settings.json, starts the daemon, and registers login
# autostart. After this runs once, claude-rpc's OWN hooks take over the
# self-heal; this script just no-ops on every later session.
#
# Scope: macOS / Linux / WSL -- the platforms where `npx ... setup` is the
# documented install. On native Windows install the portable .exe instead
# (see the project README); there this script is a graceful no-op.
# -----------------------------------------------------------------------------
set -u

# Per-plugin persistent dir (survives plugin updates; created + exported to hook
# processes by Claude Code). Fall back to ~/.claude if it is somehow unset.
DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/claude-rpc-plugin}"
mkdir -p "$DATA" 2>/dev/null || true
SENTINEL="$DATA/bootstrapped"
LOG="$DATA/bootstrap.log"
LOCK="$DATA/.lock"

# Fast skip: already bootstrapped, or the package is already on PATH (covers
# users who installed claude-rpc before adding this plugin).
[ -f "$SENTINEL" ] && exit 0
if command -v claude-rpc >/dev/null 2>&1; then
  : > "$SENTINEL" 2>/dev/null || true
  exit 0
fi

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

# Do the real work detached so SessionStart returns immediately -- the first run
# can take a while as npx fetches the package. The sentinel is written only on
# success, so a failed attempt (e.g. offline) is retried next session.
{
  if find_npx; then
    {
      echo "--- $(date 2>/dev/null) claude-rpc plugin bootstrap ---"
      if npx -y claude-rpc@latest setup; then
        : > "$SENTINEL"
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
