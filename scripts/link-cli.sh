#!/usr/bin/env bash
# Put the `hatchabot` and `hbt` commands on your PATH, and check the install.
#
#   ./scripts/link-cli.sh
#
# For a machine where the checkout exists but the command does not — after
# moving to a new laptop with Migration Assistant, a fresh shell profile, or an
# `npm link` that failed during setup. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v npm >/dev/null 2>&1 || PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v npm >/dev/null 2>&1 || { echo "npm is not installed — install Node 22 first (https://nodejs.org), then re-run."; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies…"; npm ci --silent; }

BIN="$(npm prefix -g)/bin"
if ! npm link >/dev/null 2>&1; then
  # A system-wide Node makes the global folder root-owned: give npm one of ours.
  npm config set prefix "$HOME/.npm-global"
  BIN="$HOME/.npm-global/bin"
  npm link >/dev/null
fi
[ -e "$BIN/hbt" ] || ln -s "$BIN/hatchabot" "$BIN/hbt" 2>/dev/null || true
echo "linked: $BIN/hatchabot$([ -L "$BIN/hbt" ] && echo ", $BIN/hbt")"

# The shell profile, once. zsh on a Mac, bash elsewhere; both if unsure.
case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    LINE="export PATH=\"$BIN:\$PATH\""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
      [ -f "$rc" ] || [ "$rc" = "$HOME/.$(basename "${SHELL:-bash}")rc" ] || continue
      grep -qF "$BIN" "$rc" 2>/dev/null || { printf '\n# hatchabot CLI\n%s\n' "$LINE" >> "$rc"; echo "added to $rc: $LINE"; }
    done
    export PATH="$BIN:$PATH"
    echo "Open a new terminal (or run: $LINE) for the change to take effect there."
    ;;
esac

echo
"$BIN/hatchabot" doctor || true
